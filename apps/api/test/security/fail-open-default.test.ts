import cookie from '@fastify/cookie';
import type { BridgeClient } from '@squad/bridge-client';
import { players } from '@squad/db/schema';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import authPlugin from '../../src/plugins/auth.js';
import metricsPlugin from '../../src/plugins/metrics.js';
import steamRoutes from '../../src/routes/auth-steam.js';
import { narrowedOwnerHeaders } from '../helpers/narrowed-token.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(984700);
const NO_ROLE_STEAM = testSteamId(984701);

let h: IntegrationHarness;
let bareApp: Awaited<ReturnType<typeof Fastify>>;
let ownerCookie: string;
let noRoleCookie: string;

/**
 * `plugins/metrics.ts`'s route is not registered by the shared
 * `buildIntegrationApp()` harness, so this builds a small dedicated
 * Fastify instance — sharing `h`'s real `db`/`redis` — wired with the real
 * `authPlugin` plus the Steam login routes and metrics. Two synthetic routes (bare
 * `config: {}` and `config: { public: true }`) exercise the fail-closed floor
 * and its opt-out directly, independent of any production route's own
 * decision.
 */
async function buildBareApp(harness: IntegrationHarness) {
  const app = Fastify({ logger: false });
  // Same compilers as server.ts: the Steam callback validates its query with zod.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', harness.db);
  app.decorate('redis', harness.redis);
  app.decorate('bridge', makeFakeBridge() as unknown as BridgeClient);
  app.decorate('config', {
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
    // biome-ignore lint/suspicious/noExplicitAny: partial config for isolated route test
  } as any);
  await app.register(cookie, { secret: 'fail-open-default-test-secret'.repeat(2) });
  await app.register(authPlugin);
  await app.register(steamRoutes);
  await app.register(metricsPlugin);
  app.get('/test/bare-route', { config: {} }, async () => ({ ok: true }));
  app.get('/test/public-route', { config: { public: true } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'FailOpenOwner' },
    bridge: makeFakeBridge(),
  });

  // A player with no role at all: the session resolves but holds no
  // panel_access, so the auth hook drops it to anonymous (#33).
  const [noRolePlayer] = await h.db
    .insert(players)
    .values({
      steamId64: NO_ROLE_STEAM,
      canonicalName: 'FailOpenNoRolePlayer',
      canonicalNameNormalized: 'failopennoroleplayer',
    })
    .returning({ id: players.id });
  if (!noRolePlayer) throw new Error('failed to seed no-role fixture');

  invalidatePermissionCache(noRolePlayer.id);
  ownerCookie = await loginAsOwner(h);
  const noRoleSession = await createSession(h.db, h.redis, {
    playerId: noRolePlayer.id,
    ip: null,
    userAgent: 'fail-open-default-test',
    ttlMs: 21_600_000,
  });
  noRoleCookie = `__Host-sid=${noRoleSession.token}`;

  bareApp = await buildBareApp(h);
}, 90_000);

afterAll(async () => {
  await bareApp?.close();
  await h?.cleanup();
});

describeIfDb('fail-closed auth default (#246)', () => {
  describe('the fail-closed floor', () => {
    it('a bare route with no config.permissions and no config.public returns 401 to an unauthenticated request', async () => {
      const res = await bareApp.inject({ method: 'GET', url: '/test/bare-route' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('a bare route with no config.permissions and no config.public returns 200 to an authenticated request holding no permission it needs', async () => {
      const res = await bareApp.inject({
        method: 'GET',
        url: '/test/bare-route',
        headers: await narrowedOwnerHeaders(h, ['host:view']),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('a bare route returns 401 to a session without panel_access (#33)', async () => {
      const res = await bareApp.inject({
        method: 'GET',
        url: '/test/bare-route',
        headers: { cookie: noRoleCookie },
      });
      expect(res.statusCode).toBe(401);
    });

    it('a route with config.public === true returns 200 to an unauthenticated request', async () => {
      const res = await bareApp.inject({ method: 'GET', url: '/test/public-route' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe('GET /api/v1/host/bridge-status', () => {
    it('returns 401 to an unauthenticated request', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/host/bridge-status' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('returns 200 to a request with host:view', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/host/bridge-status',
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/health/workers', () => {
    it('returns 401 to an unauthenticated request', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/health/workers' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('returns 200 to a request with host:view', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/health/workers',
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/health/reconciler', () => {
    it('returns 401 to an unauthenticated request', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    });
  });

  describe('public routes stay reachable without a session', () => {
    it('GET /health stays reachable without a session', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /ready stays reachable without a session', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/v1/auth/steam/login stays reachable without a session', async () => {
      const res = await bareApp.inject({ method: 'GET', url: '/api/v1/auth/steam/login' });
      expect(res.statusCode).toBe(302);
    });
  });

  describe('GET /metrics is operator-only (#9)', () => {
    it('returns 401 to an unauthenticated request', async () => {
      const res = await bareApp.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('returns 401 to a session whose player has no role (no panel_access)', async () => {
      const res = await bareApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { cookie: noRoleCookie },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 to an authenticated request without host:metrics', async () => {
      const res = await bareApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: await narrowedOwnerHeaders(h, ['host:view']),
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 200 to a request with host:metrics', async () => {
      const res = await bareApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('process_cpu_');
    });
  });
});
