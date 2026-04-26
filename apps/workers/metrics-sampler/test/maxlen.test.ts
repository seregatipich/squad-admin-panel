import { HOST_METRICS_MAXLEN, HOST_METRICS_STREAM } from '@squad/shared-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSampler } from '../src/sampler.js';

const SAMPLE_METRICS = {
  cpu_percent: 10,
  ram_used_bytes: 512,
  ram_total_bytes: 1024,
  disk_used_bytes: 200,
  disk_total_bytes: 2000,
  net_rx_bytes_per_sec: 5,
  net_tx_bytes_per_sec: 5,
  load_avg_1m: 0.1,
  load_avg_5m: 0.2,
  load_avg_15m: 0.3,
  sampled_at: '2026-04-25T00:00:00Z',
};

describe('runSampler – MAXLEN enforcement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes MAXLEN ~ HOST_METRICS_MAXLEN to every xadd call', async () => {
    const xaddArgs: unknown[][] = [];
    const redis = {
      xadd: vi.fn(async (...args: unknown[]) => {
        xaddArgs.push(args);
        return '0-0';
      }),
    };
    const stop = runSampler({
      bridge: { hostMetrics: vi.fn().mockResolvedValue(SAMPLE_METRICS) } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {} } as never,
      intervalMs: 50,
    });
    await vi.advanceTimersByTimeAsync(260);
    stop();

    expect(xaddArgs.length).toBeGreaterThanOrEqual(5);
    for (const args of xaddArgs) {
      expect(args[0]).toBe(HOST_METRICS_STREAM);
      expect(args[1]).toBe('MAXLEN');
      expect(args[2]).toBe('~');
      expect(args[3]).toBe(String(HOST_METRICS_MAXLEN));
    }
  });
});
