import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PREFIX,
  HEARTBEAT_TTL_SECONDS,
  heartbeatKey,
  startHeartbeat,
} from '../src/heartbeat.js';

interface SetCall {
  key: string;
  value: string;
  ttl: number;
}

function fakeRedis(): { calls: SetCall[]; set: (...a: unknown[]) => Promise<'OK'> } {
  const calls: SetCall[] = [];
  return {
    calls,
    set: vi.fn(async (key: unknown, value: unknown, _mode: unknown, ttl: unknown) => {
      calls.push({ key: String(key), value: String(value), ttl: Number(ttl) });
      return 'OK' as const;
    }) as never,
  };
}

describe('heartbeat constants', () => {
  it('publishes every 5 seconds with a 30-second TTL', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(HEARTBEAT_TTL_SECONDS).toBe(30);
    expect(HEARTBEAT_PREFIX).toBe('worker:heartbeat:');
  });

  it('builds keys under the worker:heartbeat: namespace', () => {
    expect(heartbeatKey('rcon')).toBe('worker:heartbeat:rcon');
    expect(heartbeatKey('log-ingest')).toBe('worker:heartbeat:log-ingest');
  });
});

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes immediately on start before the first interval fires', async () => {
    const r = fakeRedis();
    const stop = startHeartbeat({ redis: r as never, name: 'rcon' });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.length).toBeGreaterThanOrEqual(1);
    const first = r.calls[0];
    expect(first.key).toBe('worker:heartbeat:rcon');
    expect(first.ttl).toBe(30);
    const payload = JSON.parse(first.value);
    expect(payload.name).toBe('rcon');
    expect(typeof payload.ts).toBe('string');
    expect(typeof payload.pid).toBe('number');
    expect(typeof payload.started_at).toBe('string');
    stop();
  });

  it('republishes on every interval until cancelled', async () => {
    const r = fakeRedis();
    const stop = startHeartbeat({ redis: r as never, name: 'log-ingest', intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const initial = r.calls.length;
    await vi.advanceTimersByTimeAsync(350);
    expect(r.calls.length).toBeGreaterThan(initial);
    const ticks = r.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.length).toBe(ticks);
  });

  it('honours custom ttl + version + statusFn payload fields', async () => {
    const r = fakeRedis();
    const stop = startHeartbeat({
      redis: r as never,
      name: 'metrics-sampler',
      intervalMs: 10,
      ttlSeconds: 11,
      version: '0.1.0',
      statusFn: () => 'sampling',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls[0].ttl).toBe(11);
    const payload = JSON.parse(r.calls[0].value);
    expect(payload.version).toBe('0.1.0');
    expect(payload.status).toBe('sampling');
    stop();
  });

  it('routes redis errors to onError without throwing', async () => {
    const onError = vi.fn();
    const stop = startHeartbeat({
      redis: {
        set: vi.fn(async () => {
          throw new Error('boom');
        }),
      } as never,
      name: 'discord',
      intervalMs: 50,
      onError,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toBe('boom');
    stop();
  });

  it('stops emitting after cancellation even if a tick is mid-flight', async () => {
    const r = fakeRedis();
    const stop = startHeartbeat({ redis: r as never, name: 'rcon', intervalMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const before = r.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(r.calls.length).toBe(before);
  });

  it('omits status when statusFn returns undefined', async () => {
    const r = fakeRedis();
    const stop = startHeartbeat({
      redis: r as never,
      name: 'rcon',
      statusFn: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    const payload = JSON.parse(r.calls[0].value);
    expect(payload.status).toBeUndefined();
    stop();
  });
});
