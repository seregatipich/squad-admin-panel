import { type ChildProcess, spawn } from 'node:child_process';
import { DIAG_STREAM_KEY, DIAG_STREAM_MAXLEN } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

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
  /** True while a journalctl process is attached; false during restart backoff. */
  isRunning(): boolean;
}

const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
/** Namespace for ids derived from a journald `__CURSOR` (uuid v5). */
const CURSOR_ID_NAMESPACE = '6f1d4c1e-7a2b-4b0e-9d63-2a4c8f5e9b10';

/**
 * Follows the privileged bridge's journald unit and forwards its DIAG_EVENT
 * lines to the diag stream. A journalctl process that exits unexpectedly is
 * restarted with exponential backoff until `stop()` is called. Each restart
 * replays the last `since` window, so forwarded ids are derived from the
 * journald cursor: a replayed line keeps its id and `diagnostic_events`
 * `ON CONFLICT (id, ts)` drops the duplicate.
 */
export function startJournaldForwarder(opts: JournaldForwarderOpts): JournaldForwarderHandle {
  const unit = opts.unitName ?? 'panel-host-bridge';
  const since = opts.since ?? '30s ago';
  const spawnImpl = opts.spawnFn ?? spawn;
  const inflight = new Set<Promise<void>>();
  let child: ChildProcess | null = null;
  let stopped = false;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  function launch(): void {
    const proc = spawnImpl('journalctl', ['-u', unit, '-o', 'json', '-f', '--since', since], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!proc.stdout || !proc.stderr) {
      throw new Error('journalctl stdio pipes unavailable');
    }
    child = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      restartAttempt = 0;
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

    proc.stderr.on('data', (chunk: Buffer) => {
      opts.log.warn({ stderr: chunk.toString('utf8').trim() }, 'journalctl stderr');
    });

    proc.on('error', (err: Error) => {
      opts.log.error({ err: err.message }, 'journalctl spawn failed');
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      opts.log.info({ code, signal }, 'journalctl exited');
      if (child === proc) child = null;
      if (stopped) return;
      const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** restartAttempt);
      restartAttempt++;
      opts.log.warn({ delayMs: delay }, 'journalctl exited unexpectedly; restarting');
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopped) launch();
      }, delay);
    });
  }

  launch();

  return {
    isRunning: () => child !== null,
    stop: () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      try {
        child?.kill('SIGTERM');
      } catch {
        // already dead
      }
    },
    drain: async () => {
      const current = child;
      if (current) {
        await new Promise<void>((resolve) => {
          if (current.exitCode !== null || current.signalCode !== null) {
            resolve();
            return;
          }
          const done = () => resolve();
          current.once('exit', done);
          current.once('close', done);
        });
      }
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
  /** journald `__CURSOR` of the entry; stable across replays, null when absent. */
  cursor: string | null;
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

  const cursor =
    typeof outer.__CURSOR === 'string' && outer.__CURSOR.length > 0 ? outer.__CURSOR : null;

  return { component, kind, severity, ts, message: innerMessage, payload, cursor };
}

export async function handleJournaldLine(
  line: string,
  opts: Pick<JournaldForwarderOpts, 'redis' | 'log'>,
): Promise<boolean> {
  const parsed = parseJournaldLine(line);
  if (!parsed) return false;

  const id = parsed.cursor ? uuidv5(parsed.cursor, CURSOR_ID_NAMESPACE) : uuidv7();
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
