import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import {
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
  roles,
  sessions as sessionsTable,
} from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
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
): Promise<{ token: string; sessionId: string; orgId: string }> {
  const orgId = uuidv7();
  await db.insert(organizations).values({ id: orgId, name: 'T', slug: 't' });
  await seedSystemRoles(db, orgId);
  const ownerRole = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.orgId, orgId))
    .limit(1);
  await db.insert(players).values({
    steamId64,
    canonicalName: 'TestPlayer',
    canonicalNameNormalized: 'testplayer',
  });
  const ownerRoleId = ownerRole[0]?.id;
  if (!ownerRoleId) throw new Error('Owner role not found after seeding');
  await db.insert(playerRoleAssignments).values({ steamId64, roleId: ownerRoleId });
  await db.insert(organizationMembers).values({ steamId64, orgId, primaryRoleId: ownerRoleId });
  const result = await createSession(db, redis, {
    steamId64,
    ip: null,
    userAgent: 'test-ua',
    ttlMs: 21600 * 1000,
  });
  return { token: result.token, sessionId: result.session.id, orgId };
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
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const remaining = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    expect(remaining.length).toBe(0);
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
    const { token: tokenA } = await seedAuthedPlayer(h.db, h.redis, 76561198000000400n);
    await createSession(h.db, h.redis, {
      steamId64: 76561198000000400n,
      ip: '10.0.0.5',
      userAgent: 'second-ua',
      ttlMs: 21600 * 1000,
    });
    await h.db.insert(players).values({
      steamId64: 76561198000000401n,
      canonicalName: 'Other',
      canonicalNameNormalized: 'other',
    });
    await createSession(h.db, h.redis, {
      steamId64: 76561198000000401n,
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
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000500n);
    const second = await createSession(h.db, h.redis, {
      steamId64: 76561198000000500n,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${second.session.id}`,
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const rows = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, second.session.id));
    expect(rows.length).toBe(0);
  });

  it("returns 404 for another user's session", async () => {
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000600n);
    await h.db.insert(players).values({
      steamId64: 76561198000000601n,
      canonicalName: 'Other',
      canonicalNameNormalized: 'other',
    });
    const otherSession = await createSession(h.db, h.redis, {
      steamId64: 76561198000000601n,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${otherSession.session.id}`,
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(404);
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
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000700n);
    await createSession(h.db, h.redis, {
      steamId64: 76561198000000700n,
      ip: null,
      userAgent: 'b',
      ttlMs: 21600 * 1000,
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const remaining = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.steamId64, 76561198000000700n));
    expect(remaining.length).toBe(0);
  });
});
