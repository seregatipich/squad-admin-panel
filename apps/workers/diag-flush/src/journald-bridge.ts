import { spawn } from 'node:child_process';
import { DIAG_STREAM_KEY, DIAG_STREAM_MAXLEN } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';

export interface JournaldForwarderOpts {
  redis: Pick<Redis, 'xadd'>;
  log: Pick<Logger, 'warn' | 'error' | 'info' | 'debug'>;
  unitName?: string;
  since?: string;
  spawnFn?: typeof spawn;
}

export interface JournaldForwarderHandle {
  stop(): void;
  drain(): Promise<void>;
}

export function startJournaldForwarder(opts: JournaldForwarderOpts): JournaldForwarderHandle {
  const unit = opts.unitName ?? 'panel-host-bridge';
  const since = opts.since ?? '30s ago';
  const spawnImpl = opts.spawnFn ?? spawn;
  const child = spawnImpl('journalctl', ['-u', unit, '-o', 'json', '-f', '--since', since], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!child.stdout || !child.stderr) {
    throw new Error('journalctl stdio pipes unavailable');
  }

  const inflight = new Set<Promise<void>>();
  let stdoutBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const p = handleJournaldLine(line, opts).then(
        () => undefined,
        (err) => {
          opts.log.warn({ err: (err as Error).message }, 'diag journald-forward failed');
        },
      );
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    opts.log.warn({ stderr: chunk.toString('utf8').trim() }, 'journalctl stderr');
  });

  child.on('error', (err: Error) => {
    opts.log.error({ err: err.message }, 'journalctl spawn failed');
  });
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    opts.log.info({ code, signal }, 'journalctl exited');
  });

  return {
    stop: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    },
    drain: async () => {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const done = () => resolve();
        child.once('exit', done);
        child.once('close', done);
      });
      if (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    },
  };
}

interface ParsedDiagLine {
  component: string;
  kind: string;
  severity: string;
  message: string;
  ts: string;
  payload: Record<string, unknown>;
}

export function parseJournaldLine(line: string): ParsedDiagLine | null {
  if (!line.trim()) return null;
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = outer.MESSAGE;
  if (typeof message !== 'string') return null;
  let inner: Record<string, unknown>;
  try {
    inner = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (inner.DIAG_EVENT !== '1') return null;

  const component = typeof inner.component === 'string' ? inner.component : null;
  const kind = typeof inner.kind === 'string' ? inner.kind : null;
  const severity = typeof inner.severity === 'string' ? inner.severity : null;
  const innerMessage = typeof inner.message === 'string' ? inner.message : null;
  if (!component || !kind || !severity || !innerMessage) return null;

  const ts =
    typeof inner.ts === 'string' && inner.ts.length > 0 ? inner.ts : new Date().toISOString();

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inner)) {
    if (
      key === 'DIAG_EVENT' ||
      key === 'component' ||
      key === 'kind' ||
      key === 'severity' ||
      key === 'message' ||
      key === 'ts'
    ) {
      continue;
    }
    payload[key] = value;
  }

  return { component, kind, severity, ts, message: innerMessage, payload };
}

export async function handleJournaldLine(
  line: string,
  opts: Pick<JournaldForwarderOpts, 'redis' | 'log'>,
): Promise<boolean> {
  const parsed = parseJournaldLine(line);
  if (!parsed) return false;

  const id = uuidv7();
  await opts.redis.xadd(
    DIAG_STREAM_KEY,
    'MAXLEN',
    '~',
    DIAG_STREAM_MAXLEN,
    '*',
    'id',
    id,
    'ts',
    parsed.ts,
    'component',
    parsed.component,
    'severity',
    parsed.severity,
    'kind',
    parsed.kind,
    'message',
    parsed.message,
    'payload',
    JSON.stringify(parsed.payload),
  );
  opts.log.debug?.({ id, kind: parsed.kind }, 'diag journald-forward XADD');
  return true;
}
