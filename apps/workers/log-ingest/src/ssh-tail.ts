import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import ssh2, { type ClientChannel, type Client as SshClient } from 'ssh2';

// Same CommonJS caveat as the API route: take the default export and
// destructure, so the built worker never depends on cjs-module-lexer.
const { Client } = ssh2;

export type SshTailState = 'connecting' | 'connected' | 'error';

export interface SshTailStatus {
  state: SshTailState;
  /** Human-readable reason for `error`/`connecting` after a drop; null when healthy. */
  error: string | null;
  /** SHA-256 fingerprint of the host key the session was (or was being) opened against. */
  hostKeyFingerprint: string | null;
}

export interface SshTailParams {
  serverId: string;
  host: string;
  port: number;
  username: string;
  /** PEM private key (RSA PKCS#1) — decrypted by the caller, never logged. */
  privateKey: string;
  logPath: string;
  /**
   * Trust-on-first-use pin. `null` accepts whatever key the host presents and
   * reports it through `onHostKey`; a non-null value refuses any other key.
   */
  expectedHostKeyFingerprint: string | null;
  log: Logger;
  onLine: (line: string) => void;
  onStatus?: (status: SshTailStatus) => void;
  /** Called once with the fingerprint pinned on first use (only when `expectedHostKeyFingerprint` is null). */
  onHostKey?: (fingerprint: string) => void;
  /** Lines replayed from the end of the file on (re)connect. */
  tailLines?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  readyTimeoutMs?: number;
}

/** `SHA256:<base64>` in OpenSSH's presentation, over the raw host key blob. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The exec line the game host runs. `logPath` is validated upstream
 * (`remoteLogPath` in shared-types) to a closed character set without quotes
 * or whitespace, so wrapping it in single quotes is a complete escape.
 * `-F` (not `-f`) follows the file across Squad's nightly restart, which
 * recreates `SquadGame.log` and moves the old one to `SquadGame-backup-*`.
 */
export function tailCommand(logPath: string, lines: number): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(logPath) || logPath.split('/').includes('..')) {
    throw new Error(`refusing to tail unsafe path ${JSON.stringify(logPath)}`);
  }
  return `tail -n ${Math.max(0, Math.floor(lines))} -F -- '${logPath}'`;
}

/**
 * Keeps an SSH `tail -F` session open against a remote `SquadGame.log`,
 * splitting stdout into lines exactly like the container tail does and
 * reconnecting with exponential backoff whenever the session drops. Returns
 * a stop function; after it is called no further callbacks fire.
 */
export function tailSshLog(params: SshTailParams): () => void {
  const { serverId, host, port, username, privateKey, logPath, log, onLine, onStatus, onHostKey } =
    params;
  const tailLines = params.tailLines ?? 200;
  const initialBackoff = params.initialBackoffMs ?? 1_000;
  const maxBackoff = params.maxBackoffMs ?? 60_000;
  const readyTimeout = params.readyTimeoutMs ?? 15_000;
  const command = tailCommand(logPath, tailLines);

  let aborted = false;
  let attempt = 0;
  let conn: SshClient | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let expectedFingerprint = params.expectedHostKeyFingerprint;
  let lastFingerprint: string | null = null;

  const report = (state: SshTailState, error: string | null) => {
    if (aborted) return;
    onStatus?.({ state, error, hostKeyFingerprint: lastFingerprint });
  };

  const scheduleReconnect = (reason: string) => {
    if (aborted) return;
    const delay = Math.min(maxBackoff, initialBackoff * 2 ** Math.min(attempt, 10));
    attempt += 1;
    log.warn({ serverId, host, port, delay, reason }, 'ssh tail dropped → reconnect');
    report('connecting', reason);
    retryTimer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (aborted) return;
    retryTimer = null;
    report('connecting', null);
    const client = new Client();
    conn = client;
    let settled = false;
    let buffer = '';
    let hostKeyRejected: string | null = null;

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      client.end();
      if (conn === client) conn = null;
      scheduleReconnect(reason);
    };

    client.on('ready', () => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          fail(`exec failed: ${err.message}`);
          return;
        }
        attempt = 0;
        log.info({ serverId, host, port, logPath }, 'ssh tail attached');
        report('connected', null);
        stream.on('data', (chunk: Buffer) => {
          if (aborted) return;
          buffer += chunk.toString('utf-8');
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.endsWith('\r') ? part.slice(0, -1) : part;
            if (line.length === 0) continue;
            onLine(line);
          }
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          log.warn({ serverId, stderr: chunk.toString('utf-8').slice(0, 300) }, 'ssh tail stderr');
        });
        stream.on('close', (code: number | null) => {
          fail(`tail exited (code ${code ?? 'null'})`);
        });
      });
    });
    client.on('error', (err: Error) => {
      fail(hostKeyRejected ?? err.message);
    });
    client.on('close', () => {
      fail('connection closed');
    });

    try {
      client.connect({
        host,
        port,
        username,
        privateKey,
        readyTimeout,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const fp = hostKeyFingerprint(key);
          lastFingerprint = fp;
          if (expectedFingerprint && expectedFingerprint !== fp) {
            hostKeyRejected = `host key changed: expected ${expectedFingerprint}, got ${fp}`;
            log.error({ serverId, host, expected: expectedFingerprint, got: fp }, hostKeyRejected);
            return false;
          }
          if (!expectedFingerprint) {
            expectedFingerprint = fp;
            onHostKey?.(fp);
          }
          return true;
        },
      });
    } catch (err) {
      fail(`connect threw: ${(err as Error).message}`);
    }
  }

  connect();

  return () => {
    aborted = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    conn?.end();
    conn = null;
  };
}
