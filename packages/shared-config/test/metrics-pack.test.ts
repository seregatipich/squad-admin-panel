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

  it('treats NaN values as 0 in every slot', () => {
    const v = packHostMetrics({
      cpu_percent: Number.NaN,
      ram_used_bytes: Number.NaN,
      disk_used_bytes: Number.NaN,
      net_rx_bytes_per_sec: Number.NaN,
      net_tx_bytes_per_sec: Number.NaN,
      load_avg_1m: Number.NaN,
      load_avg_5m: Number.NaN,
      load_avg_15m: Number.NaN,
    });
    expect(v).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('clamps negative byte counters to 0 (not just cpu_percent)', () => {
    const v = packHostMetrics({
      cpu_percent: 0,
      ram_used_bytes: -1,
      disk_used_bytes: -2,
      net_rx_bytes_per_sec: -3,
      net_tx_bytes_per_sec: -4,
      load_avg_1m: -0.1,
      load_avg_5m: -0.2,
      load_avg_15m: -0.3,
    });
    expect(v).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('unpack defaults every missing slot to 0 when given a short array', () => {
    const v = unpackHostMetrics([]);
    expect(v).toEqual({
      cpu_percent: 0,
      ram_used_bytes: 0,
      disk_used_bytes: 0,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
    });
  });
});
