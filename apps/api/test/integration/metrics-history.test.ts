import { HOST_METRICS_STREAM, packHostMetrics } from '@squad/shared-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const sample = {
  cpu_percent: 50,
  ram_used_bytes: 100,
  disk_used_bytes: 1,
  net_rx_bytes_per_sec: 0,
  net_tx_bytes_per_sec: 0,
  load_avg_1m: 0,
  load_avg_5m: 0,
  load_avg_15m: 0,
};

let h: IntegrationHarness;
let cookie: string;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { email: 'owner@example.com', password: 'CorrectHorseBatteryStaple1!' },
  });
  cookie = await loginAsOwner(h);
  await h.redis.del(HOST_METRICS_STREAM);
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/v1/host/metrics/history', () => {
  it('returns paired ts/v arrays in chronological order', async () => {
    for (let i = 0; i < 5; i++) {
      const v = packHostMetrics({ ...sample, cpu_percent: i * 10 });
      await h.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(v));
    }
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=86400',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ts: number[]; v: number[][] };
    expect(body.ts).toHaveLength(5);
    expect(body.v).toHaveLength(5);
    expect(body.v[0]?.[0]).toBe(0);
    expect(body.v[4]?.[0]).toBe(4 * 10 * 100);
    for (let i = 1; i < body.ts.length; i++) {
      expect(body.ts[i]).toBeGreaterThanOrEqual(body.ts[i - 1] ?? 0);
    }
  });

  it('respects the seconds window and excludes older samples', async () => {
    const old = packHostMetrics(sample);
    const oldId = `${Date.now() - 25 * 3600 * 1000}-0`;
    await h.redis.xadd(HOST_METRICS_STREAM, oldId, 'v', JSON.stringify(old));
    const recent = packHostMetrics({ ...sample, cpu_percent: 99 });
    await h.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(recent));
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=3600',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ts: number[]; v: number[][] };
    expect(body.v).toHaveLength(1);
    expect(body.v[0]?.[0]).toBe(99 * 100);
  });

  it('returns empty arrays when stream is empty', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ts: number[]; v: number[][] };
    expect(body.ts).toEqual([]);
    expect(body.v).toEqual([]);
  });

  it('defaults to a 24h window when seconds is omitted', async () => {
    const v = packHostMetrics(sample);
    await h.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(v));
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ts: number[]; v: number[][] };
    expect(body.v).toHaveLength(1);
  });
});
