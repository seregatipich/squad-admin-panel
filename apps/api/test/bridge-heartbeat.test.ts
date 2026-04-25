import { Writable } from 'node:stream';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bridgeHeartbeatPlugin from '../src/plugins/bridge-heartbeat.js';

interface CapturedLine {
  level: number;
  msg: string;
  src?: string;
  rttMs?: number;
  downForS?: number;
  err?: string;
}

function buildHarness() {
  const captured: CapturedLine[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          captured.push({
            level: typeof obj.level === 'number' ? obj.level : 30,
            msg: typeof obj.msg === 'string' ? obj.msg : '',
            src: typeof obj.src === 'string' ? obj.src : undefined,
            rttMs: typeof obj.rttMs === 'number' ? obj.rttMs : undefined,
            downForS: typeof obj.downForS === 'number' ? obj.downForS : undefined,
            err: typeof obj.err === 'string' ? obj.err : undefined,
          });
        } catch {
          /* ignore */
        }
      }
      cb();
    },
  });
  const logger = pino({ level: 'debug' }, sink);
  return { captured, logger };
}

interface FakeBridge {
  ping: ReturnType<typeof vi.fn>;
}

let app: Awaited<ReturnType<typeof buildApp>>;
let captured: CapturedLine[];
let bridge: FakeBridge;

async function buildApp() {
  const { captured: cap, logger } = buildHarness();
  captured = cap;
  bridge = { ping: vi.fn(async () => ({ version: 'test', hostname: 'h' })) };
  const f = Fastify({ loggerInstance: logger });
  f.decorate('bridge', bridge);
  await f.register(bridgeHeartbeatPlugin);
  await f.ready();
  return f;
}

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('bridge heartbeat plugin', () => {
  it('emits a debug alive line on healthy tick', async () => {
    captured.length = 0;
    await app.bridgeHeartbeat.tickOnce();
    const aliveLine = captured.find((l) => l.src === 'bridge' && l.msg.startsWith('alive rtt='));
    expect(aliveLine).toBeDefined();
    expect(aliveLine?.level).toBe(20);
  });

  it('emits a warn `down` entry on first failure', async () => {
    bridge.ping = vi.fn(async () => {
      throw new Error('socket: ENOENT');
    });
    captured.length = 0;
    await app.bridgeHeartbeat.tickOnce();
    const down = captured.find((l) => l.src === 'bridge' && l.msg.startsWith('down:'));
    expect(down).toBeDefined();
    expect(down?.level).toBe(40);
    expect(down?.err).toContain('ENOENT');
  });

  it('emits info `recovered` when ping succeeds after a failure', async () => {
    bridge.ping = vi.fn(async () => {
      throw new Error('socket: ENOENT');
    });
    await app.bridgeHeartbeat.tickOnce();
    bridge.ping = vi.fn(async () => ({ version: 'test', hostname: 'h' }));
    captured.length = 0;
    await app.bridgeHeartbeat.tickOnce();
    const recovered = captured.find(
      (l) => l.src === 'bridge' && l.msg.startsWith('recovered after'),
    );
    expect(recovered).toBeDefined();
    expect(recovered?.level).toBe(30);
    expect(recovered?.downForS).toBeGreaterThanOrEqual(0);
  });

  it('emits debug `still down` on consecutive failures (no warn flapping)', async () => {
    bridge.ping = vi.fn(async () => {
      throw new Error('still broken');
    });
    await app.bridgeHeartbeat.tickOnce();
    captured.length = 0;
    await app.bridgeHeartbeat.tickOnce();
    const stillDown = captured.find((l) => l.msg === 'still down');
    expect(stillDown).toBeDefined();
    expect(stillDown?.level).toBe(20);
    const warns = captured.filter((l) => l.level === 40);
    expect(warns).toHaveLength(0);
  });

  it('skips re-entry while a previous tick is still in flight', async () => {
    let resolveSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    bridge.ping = vi.fn(async () => {
      await slow;
      return { version: 'test', hostname: 'h' };
    });
    captured.length = 0;
    const first = app.bridgeHeartbeat.tickOnce();
    await app.bridgeHeartbeat.tickOnce();
    expect(bridge.ping).toHaveBeenCalledTimes(1);
    resolveSlow?.();
    await first;
  });
});
