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
    expect(app.metrics.consumerEvents).toBeDefined();
    expect(app.metrics.bridgeCalls).toBeDefined();
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
