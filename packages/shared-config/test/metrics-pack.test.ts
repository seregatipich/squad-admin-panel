import { describe, expect, it } from 'vitest';
import {
  HOST_METRICS_MAXLEN,
  HOST_METRICS_STREAM,
  packHostMetrics,
  unpackHostMetrics,
} from '../src/metrics-pack.js';

describe('metrics-pack', () => {
  it('packs to 8 integers in stable order', () => {
    const v = packHostMetrics({
      cpu_percent: 73.51,
      ram_used_bytes: 1234567890,
      disk_used_bytes: 55667788,
      net_rx_bytes_per_sec: 1234,
      net_tx_bytes_per_sec: 567,
      load_avg_1m: 0.53,
      load_avg_5m: 0.71,
      load_avg_15m: 0.89,
    });
    expect(v).toEqual([7351, 1234567890, 55667788, 1234, 567, 53, 71, 89]);
  });

  it('round-trips values within a tolerance of 0.01', () => {
    const original = {
      cpu_percent: 12.34,
      ram_used_bytes: 999,
      disk_used_bytes: 1,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 1.23,
      load_avg_15m: 4.56,
    };
    const round = unpackHostMetrics(packHostMetrics(original));
    expect(round.cpu_percent).toBeCloseTo(12.34, 2);
    expect(round.load_avg_5m).toBeCloseTo(1.23, 2);
    expect(round.ram_used_bytes).toBe(999);
  });

  it('exposes stable stream constants', () => {
    expect(HOST_METRICS_STREAM).toBe('host:metrics');
    expect(HOST_METRICS_MAXLEN).toBe(5760);
  });

  it('clamps negatives to 0', () => {
    const v = packHostMetrics({
      cpu_percent: -5,
      ram_used_bytes: 0,
      disk_used_bytes: 0,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
    });
    expect(v[0]).toBe(0);
  });
});
