import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { players, roles, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import authRoutes from '../src/routes/auth.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from './integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function buildApp(opts: { dbUrl: string }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const sql = postgres(opts.dbUrl, { max: 4, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: integration test
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  const testConfig = {
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
  };
  // biome-ignore lint/suspicious/noExplicitAny: simplified test config
  app.decorate('config', testConfig as any);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await app.register(liveBusPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.ready();
  return {
    app,
    db,
    redis,
    sql,
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

async function seedAuthedPlayer(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
  db: any,
  redis: Redis,
  steamId64: bigint,
): Promise<{ token: string; sessionId: string; playerId: string }> {
  const ownerRoleRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const ownerRoleId = ownerRoleRows[0]?.id;
  if (!ownerRoleId) throw new Error('Owner role missing — migration 0009 not applied?');
  const [{ id: insertedId }] = await db
    .insert(players)
    .values({
      steamId64,
      canonicalName: 'TestPlayer',
      canonicalNameNormalized: 'testplayer',
      roleId: ownerRoleId,
    })
    .returning({ id: players.id });
  const result = await createSession(db, redis, {
    playerId: insertedId,
    ip: null,
    userAgent: 'test-ua',
    ttlMs: 21600 * 1000,
  });
  return { token: result.token, sessionId: result.session.id, playerId: insertedId };
}

describe('GET /api/v1/me', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('returns 401 when no cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns steam_id64 + canonical_name + permissions', async () => {
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000300n);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      steam_id64: string;
      canonical_name: string;
      permissions: string[];
    };
    expect(body.steam_id64).toBe('76561198000000300');
    expect(body.canonical_name).toBe('TestPlayer');
    expect(body.permissions.length).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/auth/logout', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('revokes the current session and clears cookie', async () => {
    const { token, sessionId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000301n);
    const revokedIds = new Set<string>();
    const unsub = h.app.liveBus.subscribe((event: LiveEvent) => {
      if (event.type === 'session.revoked') revokedIds.add(event.data.session_id);
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    unsub();
    expect(res.statusCode).toBe(200);
    const remaining = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    expect(remaining.length).toBe(0);
    expect(revokedIds.has(sessionId)).toBe(true);
  });
});

describe('GET /api/v1/me/sessions', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('lists only own sessions and marks current', async () => {
    const { token: tokenA, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000400n);
    await createSession(h.db, h.redis, {
      playerId,
      ip: '10.0.0.5',
      userAgent: 'second-ua',
      ttlMs: 21600 * 1000,
    });
    const [{ id: otherPlayerId }] = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000000401n,
        canonicalName: 'Other',
        canonicalNameNormalized: 'other',
      })
      .returning({ id: players.id });
    await createSession(h.db, h.redis, {
      playerId: otherPlayerId,
      ip: '10.0.0.6',
      userAgent: 'other-ua',
      ttlMs: 21600 * 1000,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: tokenA },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; current: boolean }>;
    expect(list.length).toBe(2);
    expect(list.filter((s) => s.current).length).toBe(1);
  });
});

describe('DELETE /api/v1/me/sessions/:id', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('revokes own session by id', async () => {
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000500n);
    const second = await createSession(h.db, h.redis, {
      playerId,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const revoked: Array<{ playerId: string; sessionId: string }> = [];
    const unsub = h.app.liveBus.subscribe((event: LiveEvent) => {
      if (event.type === 'session.revoked')
        revoked.push({ playerId: event.data.player_id, sessionId: event.data.session_id });
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${second.session.id}`,
      cookies: { [SESSION_COOKIE]: token },
    });
    unsub();
    expect(res.statusCode).toBe(200);
    const rows = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, second.session.id));
    expect(rows.length).toBe(0);
    expect(revoked.some((e) => e.sessionId === second.session.id && e.playerId === playerId)).toBe(
      true,
    );
  });

  it("returns 404 for another user's session", async () => {
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000600n);
    const [{ id: otherPlayerId }] = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000000601n,
        canonicalName: 'Other',
        canonicalNameNormalized: 'other',
      })
      .returning({ id: players.id });
    const otherSession = await createSession(h.db, h.redis, {
      playerId: otherPlayerId,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const revokedIds = new Set<string>();
    const unsub = h.app.liveBus.subscribe((event: LiveEvent) => {
      if (event.type === 'session.revoked') revokedIds.add(event.data.session_id);
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${otherSession.session.id}`,
      cookies: { [SESSION_COOKIE]: token },
    });
    unsub();
    expect(res.statusCode).toBe(404);
    expect(revokedIds.has(otherSession.session.id)).toBe(false);
    const stillThere = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, otherSession.session.id));
    expect(stillThere.length).toBe(1);
  });
});

describe('DELETE /api/v1/me/sessions', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('logs out all sessions for the player', async () => {
    const { token, sessionId, playerId } = await seedAuthedPlayer(
      h.db,
      h.redis,
      76561198000000700n,
    );
    const second = await createSession(h.db, h.redis, {
      playerId,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const revokedIds = new Set<string>();
    const unsub = h.app.liveBus.subscribe((event: LiveEvent) => {
      if (event.type === 'session.revoked') revokedIds.add(event.data.session_id);
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: token },
    });
    unsub();
    expect(res.statusCode).toBe(200);
    const remaining = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.playerId, playerId));
    expect(remaining.length).toBe(0);
    expect(revokedIds.has(sessionId)).toBe(true);
    expect(revokedIds.has(second.session.id)).toBe(true);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/api/v1/me/sessions' });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/v1/me/sessions/:id — revoke own current session', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('can revoke the current session (own active session)', async () => {
    const { token, sessionId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000800n);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${sessionId}`,
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const rows = await h.db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(rows.length).toBe(0);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/me/sessions/some-session-id',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/me/sessions — pagination implicit', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('session list shows correct count when player has multiple sessions', async () => {
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000900n);
    await createSession(h.db, h.redis, {
      playerId,
      ip: null,
      userAgent: 'extra-ua',
      ttlMs: 21600 * 1000,
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list.length).toBe(2);
  });
});
