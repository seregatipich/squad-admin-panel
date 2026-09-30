import { CONTAINER_METRICS_MAXLEN, CONTAINER_METRICS_TTL_SECONDS } from '@squad/shared-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectContainerMetrics, getRunningServerIds, runSampler } from '../src/sampler.js';

interface XaddCall {
  stream: string;
  entries: Array<[string, string]>;
}

function makeRedis(getResponses?: Record<string, string | null>): {
  calls: XaddCall[];
  xadd: (...a: unknown[]) => Promise<string>;
  mget: (...keys: string[]) => Promise<Array<string | null>>;
  mgetCalls: string[][];
  expire: (key: string, seconds: number) => Promise<number>;
  expireCalls: Array<[string, number]>;
} {
  const mgetCalls: string[][] = [];
  const expireCalls: Array<[string, number]> = [];
  const calls: XaddCall[] = [];
  return {
    calls,
    mgetCalls,
    expireCalls,
    expire: async (key: string, seconds: number) => {
      expireCalls.push([key, seconds]);
      return 1;
    },
    xadd: async (...args: unknown[]) => {
      const [stream] = args as [string, ...unknown[]];
      const tail = (args as unknown[]).slice(5);
      const entries: Array<[string, string]> = [];
      for (let i = 0; i < tail.length; i += 2) {
        entries.push([String(tail[i]), String(tail[i + 1])]);
      }
      calls.push({ stream: String(stream), entries });
      return '0-0';
    },
    mget: async (...keys: string[]) => {
      mgetCalls.push(keys);
      return keys.map((key) => getResponses?.[key] ?? null);
    },
  };
}

describe('runSampler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('XADDs one packed sample per tick to host:metrics', async () => {
    const redis = makeRedis();
    const bridgeMetrics = vi.fn(async () => ({
      cpu_percent: 50,
      ram_used_bytes: 100,
      ram_total_bytes: 200,
      disk_used_bytes: 100,
      disk_total_bytes: 1000,
      net_rx_bytes_per_sec: 10,
      net_tx_bytes_per_sec: 20,
      load_avg_1m: 0.5,
      load_avg_5m: 0.6,
      load_avg_15m: 0.7,
      sampled_at: '2026-04-25T00:00:00Z',
    }));
    const stop = runSampler({
      bridge: { hostMetrics: bridgeMetrics } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(305);
    stop();
    expect(bridgeMetrics).toHaveBeenCalled();
    expect(redis.calls.length).toBeGreaterThanOrEqual(3);
    expect(redis.calls[0].stream).toBe('host:metrics');
    const vEntry = redis.calls[0].entries.find(([k]) => k === 'v');
    expect(vEntry).toBeDefined();
    expect(JSON.parse(vEntry?.[1])).toEqual([5000, 100, 100, 10, 20, 50, 60, 70]);
  });

  it('continues sampling after a bridge error', async () => {
    const redis = makeRedis();
    let calls = 0;
    const bridgeMetrics = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('bridge down');
      return {
        cpu_percent: 1,
        ram_used_bytes: 1,
        ram_total_bytes: 2,
        disk_used_bytes: 1,
        disk_total_bytes: 2,
        net_rx_bytes_per_sec: 0,
        net_tx_bytes_per_sec: 0,
        load_avg_1m: 0,
        load_avg_5m: 0,
        load_avg_15m: 0,
        sampled_at: '2026-04-25T00:00:00Z',
      };
    });
    const stop = runSampler({
      bridge: { hostMetrics: bridgeMetrics } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(305);
    stop();
    expect(redis.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips a tick while the previous one is still running', async () => {
    const redis = makeRedis();
    const bridgeMetrics = vi.fn(() => new Promise<never>(() => {}));
    const stop = runSampler({
      bridge: { hostMetrics: bridgeMetrics } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(505);
    stop();
    expect(bridgeMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('getRunningServerIds', () => {
  function makeScanRedis(data: Record<string, string>) {
    const keys = Object.keys(data);
    const mgetCalls: string[][] = [];
    return {
      scan: async (cursor: string | number, ..._args: unknown[]): Promise<[string, string[]]> => {
        // Return all keys on first call, then '0' cursor to stop
        if (String(cursor) === '0') return ['0', keys];
        return ['0', []];
      },
      mget: async (...keys: string[]): Promise<Array<string | null>> => {
        mgetCalls.push(keys);
        return keys.map((key) => data[key] ?? null);
      },
      mgetCalls,
    };
  }

  it('returns IDs for connected/connecting servers', async () => {
    const redis = makeScanRedis({
      'rcon:status:aaa': JSON.stringify({ state: 'connected' }),
      'rcon:status:bbb': JSON.stringify({ state: 'connecting' }),
    });
    const ids = await getRunningServerIds(redis as never);
    expect(ids.sort()).toEqual(['aaa', 'bbb']);
  });

  it('skips servers with other states', async () => {
    const redis = makeScanRedis({
      'rcon:status:aaa': JSON.stringify({ state: 'connected' }),
      'rcon:status:bbb': JSON.stringify({ state: 'not_polled' }),
      'rcon:status:ccc': JSON.stringify({ state: 'disconnected' }),
    });
    const ids = await getRunningServerIds(redis as never);
    expect(ids).toEqual(['aaa']);
  });

  it('reads every key of a scan page with a single MGET', async () => {
    const redis = makeScanRedis({
      'rcon:status:aaa': JSON.stringify({ state: 'connected' }),
      'rcon:status:bbb': JSON.stringify({ state: 'connecting' }),
      'rcon:status:ccc': JSON.stringify({ state: 'disconnected' }),
    });
    await getRunningServerIds(redis as never);
    expect(redis.mgetCalls).toEqual([['rcon:status:aaa', 'rcon:status:bbb', 'rcon:status:ccc']]);
  });

  it('skips JSON values that are not objects', async () => {
    const redis = makeScanRedis({
      'rcon:status:aaa': 'null',
      'rcon:status:bbb': '42',
      'rcon:status:ccc': JSON.stringify({ state: 'connected' }),
    });
    expect(await getRunningServerIds(redis as never)).toEqual(['ccc']);
  });

  it('handles empty keys result', async () => {
    const redis = makeScanRedis({});
    const ids = await getRunningServerIds(redis as never);
    expect(ids).toEqual([]);
  });

  it('skips malformed JSON values', async () => {
    const redis = makeScanRedis({
      'rcon:status:aaa': '{bad json',
      'rcon:status:bbb': JSON.stringify({ state: 'connected' }),
    });
    const ids = await getRunningServerIds(redis as never);
    expect(ids).toEqual(['bbb']);
  });
});

describe('collectContainerMetrics', () => {
  const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never;

  it('calls containerStats for each server ID and writes to stream', async () => {
    const redis = makeRedis();
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 12.5,
        mem_used_bytes: 1_000_000,
        mem_percent: 25.0,
        pids: 10,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1', 's2'], log);
    expect(bridge.containerStats).toHaveBeenCalledTimes(2);
    expect(bridge.containerStats).toHaveBeenCalledWith({ name: 'squad-s1' });
    expect(bridge.containerStats).toHaveBeenCalledWith({ name: 'squad-s2' });
    expect(redis.calls.length).toBe(2);
    expect(redis.calls[0].stream).toBe('container:metrics:s1');
    expect(redis.calls[1].stream).toBe('container:metrics:s2');
    const parsed = JSON.parse(redis.calls[0].entries.find(([k]) => k === 'v')?.[1] ?? '');
    expect(parsed.cpu_percent).toBe(12.5);
  });

  it('skips servers where stats.found is false', async () => {
    const redis = makeRedis();
    const bridge = {
      containerStats: vi.fn(async () => ({ found: false })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1'], log);
    expect(bridge.containerStats).toHaveBeenCalledTimes(1);
    expect(redis.calls.length).toBe(0);
  });

  it('continues on error for individual servers', async () => {
    const redis = makeRedis();
    let callCount = 0;
    const bridge = {
      containerStats: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('boom');
        return {
          found: true,
          cpu_percent: 5,
          mem_used_bytes: 500,
          mem_percent: 10,
          pids: 3,
          sampled_at: '2026-04-25T00:00:00Z',
        };
      }),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1', 's2'], log);
    expect(bridge.containerStats).toHaveBeenCalledTimes(2);
    // Only s2 wrote (s1 threw)
    expect(redis.calls.length).toBe(1);
    expect(redis.calls[0].stream).toBe('container:metrics:s2');
  });

  it('writes correct MAXLEN to stream', async () => {
    const xaddArgs: unknown[][] = [];
    const redis = {
      xadd: async (...args: unknown[]) => {
        xaddArgs.push(args);
        return '0-0';
      },
      mget: async (...keys: string[]) => keys.map(() => null),
      expire: async () => 1,
    };
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 1,
        mem_used_bytes: 1,
        mem_percent: 1,
        pids: 1,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1'], log);
    // args: [streamKey, 'MAXLEN', '~', '2880', '*', 'v', json]
    expect(xaddArgs[0][1]).toBe('MAXLEN');
    expect(xaddArgs[0][2]).toBe('~');
    expect(xaddArgs[0][3]).toBe(String(CONTAINER_METRICS_MAXLEN));
  });

  it('reads all tickrates with one MGET and renews each stream TTL', async () => {
    const redis = makeRedis({
      'rcon:status:s1': JSON.stringify({ tickrate_rt: 40 }),
      'rcon:status:s2': 'null',
    });
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 1,
        mem_used_bytes: 1,
        mem_percent: 1,
        pids: 1,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1', 's2'], log);
    expect(redis.mgetCalls).toEqual([['rcon:status:s1', 'rcon:status:s2']]);
    expect(redis.expireCalls).toEqual([
      ['container:metrics:s1', CONTAINER_METRICS_TTL_SECONDS],
      ['container:metrics:s2', CONTAINER_METRICS_TTL_SECONDS],
    ]);
    const second = JSON.parse(redis.calls[1].entries.find(([k]) => k === 'v')?.[1] ?? '');
    expect(second.tickrate).toBeUndefined();
  });

  it('includes tickrate when rcon:status contains tickrate_rt', async () => {
    const redis = makeRedis({
      'rcon:status:s1': JSON.stringify({ state: 'connected', tickrate_rt: 48.5 }),
    });
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 10,
        mem_used_bytes: 500,
        mem_percent: 5,
        pids: 2,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1'], log);
    expect(redis.calls.length).toBe(1);
    const parsed = JSON.parse(redis.calls[0].entries.find(([k]) => k === 'v')?.[1] ?? '');
    expect(parsed.tickrate).toBe(48.5);
  });

  it('tickrate is undefined when rcon:status has no tickrate_rt', async () => {
    const redis = makeRedis({
      'rcon:status:s1': JSON.stringify({ state: 'connected' }),
    });
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 10,
        mem_used_bytes: 500,
        mem_percent: 5,
        pids: 2,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1'], log);
    const parsed = JSON.parse(redis.calls[0].entries.find(([k]) => k === 'v')?.[1] ?? '');
    expect(parsed.tickrate).toBeUndefined();
  });

  it('tickrate is undefined when redis.get fails', async () => {
    const redis = makeRedis();
    // Override get to throw
    redis.mget = async () => {
      throw new Error('redis down');
    };
    const bridge = {
      containerStats: vi.fn(async () => ({
        found: true,
        cpu_percent: 10,
        mem_used_bytes: 500,
        mem_percent: 5,
        pids: 2,
        sampled_at: '2026-04-25T00:00:00Z',
      })),
    };
    await collectContainerMetrics(bridge as never, redis as never, ['s1'], log);
    expect(redis.calls.length).toBe(1);
    const parsed = JSON.parse(redis.calls[0].entries.find(([k]) => k === 'v')?.[1] ?? '');
    expect(parsed.tickrate).toBeUndefined();
  });
});
