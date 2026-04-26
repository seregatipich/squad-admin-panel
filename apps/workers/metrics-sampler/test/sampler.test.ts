import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSampler } from '../src/sampler.js';

interface XaddCall {
  stream: string;
  entries: Array<[string, string]>;
}

function makeRedis(): { calls: XaddCall[]; xadd: (...a: unknown[]) => Promise<string> } {
  const calls: XaddCall[] = [];
  return {
    calls,
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
});
