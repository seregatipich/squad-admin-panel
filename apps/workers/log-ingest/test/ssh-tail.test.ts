import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostKeyFingerprint, tailCommand, tailSshLog } from '../src/ssh-tail.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function rsaPem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}

const HOST_KEY = rsaPem();
const CLIENT_KEY = rsaPem();
const OTHER_CLIENT_KEY = rsaPem();

function parsedKey(pem: string) {
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? (parsed[0] as NonNullable<(typeof parsed)[0]>) : parsed;
}

interface FakeHost {
  port: number;
  fingerprint: string;
  execs: string[];
  connections: number;
  close(): Promise<void>;
}

/**
 * In-process sshd: accepts exactly `CLIENT_KEY` for user `squad`, answers one
 * exec per session by streaming `script(sessionIndex)` lines, then ends the
 * channel (which is what a killed `tail -F` looks like to the client).
 */
async function startFakeHost(
  script: (session: number) => string[] | Promise<string[]>,
  opts: { hostKey?: string; closeAfterLines?: boolean } = {},
): Promise<FakeHost> {
  const allowed = parsedKey(CLIENT_KEY);
  const execs: string[] = [];
  let sessions = 0;
  let connections = 0;
  const server = new Server({ hostKeys: [opts.hostKey ?? HOST_KEY] }, (client) => {
    connections += 1;
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey' || ctx.username !== 'squad') return ctx.reject();
      const presented = ctx.key.data;
      const expected = allowed.getPublicSSH();
      if (
        ctx.key.algo !== allowed.type ||
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected) ||
        (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
      ) {
        return ctx.reject();
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.once('exec', async (acceptExec, _reject, info) => {
          execs.push(info.command);
          const stream = acceptExec();
          const index = sessions++;
          for (const line of await script(index)) {
            stream.write(`${line}\n`);
          }
          if (opts.closeAfterLines !== false) {
            stream.exit(0);
            stream.end();
          }
        });
      });
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const hostPub = parsedKey(opts.hostKey ?? HOST_KEY).getPublicSSH();
  return {
    port,
    fingerprint: hostKeyFingerprint(hostPub),
    execs,
    get connections() {
      return connections;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(20);
  expect(predicate()).toBe(true);
}

const LOG_PATH = '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log';

describe('tailCommand', () => {
  it('quotes the validated path and follows by name', () => {
    expect(tailCommand(LOG_PATH, 200)).toBe(`tail -n 200 -F -- '${LOG_PATH}'`);
  });

  it('refuses anything outside the closed character set', () => {
    expect(() => tailCommand("/opt/x'; id; '", 10)).toThrow(/unsafe path/);
    expect(() => tailCommand('/opt/../etc/passwd', 10)).toThrow(/unsafe path/);
    expect(() => tailCommand('relative.log', 10)).toThrow(/unsafe path/);
  });
});

describe('tailSshLog', () => {
  const stops: Array<() => void> = [];
  const hosts: FakeHost[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const host of hosts.splice(0)) await host.close();
  });

  it('authenticates with the key, runs tail -F on the path and splits stdout into lines', async () => {
    const host = await startFakeHost(
      () => ['[2026.09.07-09.00.00:000][  1]LogSquad: one', 'two\r', '', 'three'],
      {
        closeAfterLines: false,
      },
    );
    hosts.push(host);
    const lines: string[] = [];
    const statuses: string[] = [];
    let pinned: string | null = null;
    stops.push(
      tailSshLog({
        serverId: 'srv-ext',
        host: '127.0.0.1',
        port: host.port,
        username: 'squad',
        privateKey: CLIENT_KEY,
        logPath: LOG_PATH,
        expectedHostKeyFingerprint: null,
        log: makeLogger(),
        onLine: (line) => lines.push(line),
        onStatus: (s) => statuses.push(s.state),
        onHostKey: (fp) => {
          pinned = fp;
        },
      }),
    );
    await waitFor(() => lines.length === 3);
    expect(lines).toEqual(['[2026.09.07-09.00.00:000][  1]LogSquad: one', 'two', 'three']);
    expect(host.execs).toEqual([`tail -n 200 -F -- '${LOG_PATH}'`]);
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(pinned).toBe(host.fingerprint);
  });

  it('reconnects with backoff after the remote tail ends and replays through the same onLine', async () => {
    const host = await startFakeHost((session) => [`session-${session}`]);
    hosts.push(host);
    const lines: string[] = [];
    const statuses: Array<{ state: string; error: string | null }> = [];
    stops.push(
      tailSshLog({
        serverId: 'srv-ext',
        host: '127.0.0.1',
        port: host.port,
        username: 'squad',
        privateKey: CLIENT_KEY,
        logPath: LOG_PATH,
        expectedHostKeyFingerprint: host.fingerprint,
        log: makeLogger(),
        onLine: (line) => lines.push(line),
        onStatus: (s) => statuses.push({ state: s.state, error: s.error }),
        initialBackoffMs: 30,
        maxBackoffMs: 60,
      }),
    );
    await waitFor(() => lines.length >= 2, 6000);
    expect(lines.slice(0, 2)).toEqual(['session-0', 'session-1']);
    expect(host.connections).toBeGreaterThanOrEqual(2);
    const drop = statuses.find((s) => s.state === 'connecting' && s.error);
    expect(drop?.error).toMatch(/tail exited|connection closed/);
  });

  it('refuses a host whose key differs from the pinned fingerprint and keeps retrying', async () => {
    const host = await startFakeHost(() => ['should-never-arrive'], { closeAfterLines: false });
    hosts.push(host);
    const lines: string[] = [];
    const errors: string[] = [];
    const log = makeLogger();
    stops.push(
      tailSshLog({
        serverId: 'srv-ext',
        host: '127.0.0.1',
        port: host.port,
        username: 'squad',
        privateKey: CLIENT_KEY,
        logPath: LOG_PATH,
        expectedHostKeyFingerprint: 'SHA256:not-the-real-one',
        log,
        onLine: (line) => lines.push(line),
        onStatus: (s) => {
          if (s.error) errors.push(s.error);
        },
        initialBackoffMs: 30,
        maxBackoffMs: 60,
      }),
    );
    await waitFor(() => errors.length >= 2, 6000);
    expect(errors[0]).toMatch(/host key changed/);
    expect(lines).toEqual([]);
    expect(host.execs).toEqual([]);
  });

  it('reports an authentication failure as a connecting/error status without lines', async () => {
    const host = await startFakeHost(() => ['nope'], { closeAfterLines: false });
    hosts.push(host);
    const errors: string[] = [];
    const lines: string[] = [];
    stops.push(
      tailSshLog({
        serverId: 'srv-ext',
        host: '127.0.0.1',
        port: host.port,
        username: 'squad',
        privateKey: OTHER_CLIENT_KEY,
        logPath: LOG_PATH,
        expectedHostKeyFingerprint: null,
        log: makeLogger(),
        onLine: (line) => lines.push(line),
        onStatus: (s) => {
          if (s.error) errors.push(s.error);
        },
        initialBackoffMs: 30,
        maxBackoffMs: 60,
      }),
    );
    await waitFor(() => errors.length >= 1, 6000);
    expect(errors[0]).toMatch(/authentication|All configured authentication methods failed/i);
    expect(lines).toEqual([]);
  });

  it('stop() ends the session and suppresses further callbacks', async () => {
    const host = await startFakeHost(() => ['alpha'], { closeAfterLines: false });
    hosts.push(host);
    const lines: string[] = [];
    const statuses: string[] = [];
    const stop = tailSshLog({
      serverId: 'srv-ext',
      host: '127.0.0.1',
      port: host.port,
      username: 'squad',
      privateKey: CLIENT_KEY,
      logPath: LOG_PATH,
      expectedHostKeyFingerprint: null,
      log: makeLogger(),
      onLine: (line) => lines.push(line),
      onStatus: (s) => statuses.push(s.state),
      initialBackoffMs: 30,
    });
    await waitFor(() => lines.length === 1);
    stop();
    const before = statuses.length;
    await sleep(200);
    expect(statuses.length).toBe(before);
    expect(host.connections).toBe(1);
  });
});
