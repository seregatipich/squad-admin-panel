import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import { registerRateLimits } from '../src/plugins/rate-limit.js';

/**
 * #1234 — the per-route limiter runs after the global auth hook, which answers
 * 401 on its own, so anonymous or forged-credential traffic was never counted
 * while each request still cost a Redis GET and a Postgres SELECT. The
 * pre-auth limiter must throttle it before any session lookup.
 */

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

async function buildApp(preAuthMax: number) {
  const sessionLookups = vi.fn(async () => null);
  app = Fastify({ logger: false });
  app.decorate('redis', { get: sessionLookups } as never);
  const noRows = { from: () => ({ where: () => ({ limit: async () => [] }) }) };
  app.decorate('db', { select: () => noRows } as never);
  app.decorate('config', {
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
  } as never);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await registerRateLimits(app, { preAuthMax });
  await app.register(authPlugin);
  app.get('/api/v1/private', async () => ({ ok: true }));
  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));
  await app.ready();
  return { sessionLookups };
}

describe('pre-auth rate limit (#1234)', () => {
  it('throttles forged-cookie requests per IP before they reach the session store', async () => {
    const { sessionLookups } = await buildApp(5);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/private',
        cookies: { [SESSION_COOKIE]: `forged-${i}` },
      });
      codes.push(res.statusCode);
    }

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    expect(sessionLookups).toHaveBeenCalledTimes(5);
  });

  it('counts each client IP separately', async () => {
    await buildApp(2);
    const from = (ip: string) =>
      app.inject({ method: 'GET', url: '/api/v1/private', remoteAddress: ip });

    await from('10.0.0.1');
    await from('10.0.0.1');
    expect((await from('10.0.0.1')).statusCode).toBe(429);
    expect((await from('10.0.0.2')).statusCode).toBe(401);
  });

  it('keeps the per-route limiter headers on authenticated-path routes', async () => {
    await buildApp(100);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('1200');
  });
});
