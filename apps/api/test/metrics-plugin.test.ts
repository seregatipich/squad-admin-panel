import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import metricsPlugin from '../src/plugins/metrics.js';

let app: Awaited<ReturnType<typeof Fastify>>;

beforeEach(async () => {
  app = Fastify();
  await app.register(metricsPlugin);
  app.get('/test-route', async () => ({ ok: true }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('metrics plugin', () => {
  it('decorates app with metrics context containing registry and counters', () => {
    expect(app.metrics).toBeDefined();
    expect(app.metrics.registry).toBeDefined();
    expect(app.metrics.httpRequests).toBeDefined();
    expect(app.metrics.httpDuration).toBeDefined();
    // Counters nothing increments are not registered: they would always
    // scrape as 0 and suggest the bridge and event consumers are monitored.
    expect(Object.keys(app.metrics).sort()).toEqual(['httpDuration', 'httpRequests', 'registry']);
  });

  it('GET /metrics returns prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('process_cpu_');
  });

  it('increments http_requests_total on response', async () => {
    await app.inject({ method: 'GET', url: '/test-route' });
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).toContain('http_requests_total');
    expect(metricsRes.body).toContain('route="/test-route"');
    expect(metricsRes.body).toContain('method="GET"');
    expect(metricsRes.body).toContain('status="200"');
  });

  it('records http_request_duration_seconds histogram', async () => {
    await app.inject({ method: 'GET', url: '/test-route' });
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).toContain('http_request_duration_seconds');
  });

  it('increments counter multiple times for repeated requests', async () => {
    await app.inject({ method: 'GET', url: '/test-route' });
    await app.inject({ method: 'GET', url: '/test-route' });
    await app.inject({ method: 'GET', url: '/test-route' });
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).toMatch(/http_requests_total\{[^}]*route="\/test-route"[^}]*\} [3-9]/);
  });
});

describe('metrics plugin — route label cardinality (#9)', () => {
  function seriesCount(body: string, metric: string): number {
    return body.split('\n').filter((line) => line.startsWith(`${metric}{`)).length;
  }

  it('collapses every unmatched URL into one constant route label', async () => {
    for (let i = 0; i < 25; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/unmatched-${i}?token=secret-${i}` });
      expect(res.statusCode).toBe(404);
    }
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).not.toContain('unmatched-');
    expect(body).not.toContain('secret-');
    expect(body).toContain('route="__unmatched__"');
    expect(seriesCount(body, 'http_requests_total')).toBe(1);
  });

  it('keeps the series count flat no matter how many distinct unmatched URLs arrive', async () => {
    await app.inject({ method: 'GET', url: '/api/first-miss' });
    const before = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    for (let i = 0; i < 50; i += 1) {
      await app.inject({ method: 'GET', url: `/api/miss/${i}/${'x'.repeat(i)}` });
    }
    const after = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(seriesCount(after, 'http_requests_total')).toBe(
      seriesCount(before, 'http_requests_total') + 1,
    );
    expect(seriesCount(after, 'http_request_duration_seconds_bucket')).toBe(
      seriesCount(before, 'http_request_duration_seconds_bucket') + 12,
    );
  });

  it('still labels matched routes by their templated path, never the raw URL', async () => {
    await app.close();
    app = Fastify();
    await app.register(metricsPlugin);
    app.get('/items/:id', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/items/123?q=raw' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('route="/items/:id"');
    expect(body).not.toContain('q=raw');
  });
});
