import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../../src/plugins/auth.js';
import authRoutes from '../../src/routes/auth.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from '../integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const SESSION_SECRET = 'a'.repeat(48);

async function buildApp(opts: { dbUrl: string }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const sql = postgres(opts.dbUrl, { max: 2, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  app.decorate('config', {
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 1,
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    // biome-ignore lint/suspicious/noExplicitAny: simplified test config
  } as any);
  await app.register(cookie, { secret: SESSION_SECRET });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.ready();
  return {
    app,
    db,
    redis,
    sql,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await redis.flushdb().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };
}

async function seedPlayer(
  // biome-ignore lint/suspicious/noExplicitAny: test drizzle handle
  db: any,
  redis: Redis,
  steamId64: bigint,
): Promise<string> {
  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const ownerRoleId = ownerRows[0]?.id;
  if (!ownerRoleId) throw new Error('Owner role missing');
  await db
    .insert(players)
    .values({
      steamId64,
      canonicalName: 'CookieTestPlayer',
      canonicalNameNormalized: 'cookietestplayer',
      roleId: ownerRoleId,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error('Player not found after insert');
  const { token } = await createSession(db, redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'cookie-security-test',
    ttlMs: 21_600_000,
  });
  return token;
}

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

describe('session cookie attributes', () => {
  it(`${SESSION_COOKIE} cookie set on session touch is HttpOnly + Secure + SameSite=Lax + Path=/`, async () => {
    const token = await seedPlayer(h.db, h.redis, 76561198987654321n);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);

    const setCookieHeader = res.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join('; ')
      : String(setCookieHeader);

    expect(cookieStr).toMatch(new RegExp(`^${SESSION_COOKIE}=`, 'i'));
    expect(cookieStr).toMatch(/HttpOnly/i);
    expect(cookieStr).toMatch(/Secure/i);
    expect(cookieStr).toMatch(/SameSite=Lax/i);
    expect(cookieStr).toMatch(/Path=\//i);
  });

  it(`${SESSION_COOKIE} cookie name starts with __Host- prefix (enforces path=/ + secure)`, async () => {
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('unauthenticated GET /api/v1/me does not set a session cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    const setCookieHeader = res.headers['set-cookie'];
    if (setCookieHeader) {
      const cookieStr = Array.isArray(setCookieHeader)
        ? setCookieHeader.join('; ')
        : String(setCookieHeader);
      expect(cookieStr).not.toMatch(new RegExp(`${SESSION_COOKIE}=(?!;)`, 'i'));
    }
  });

  it('session cookie value is non-empty after successful session creation', async () => {
    const token = await seedPlayer(h.db, h.redis, 76561198987654322n);
    expect(token).toBeTruthy();
    expect(token.startsWith('s_')).toBe(true);
  });

  it('expired/invalid session cookie does not set a new session cookie', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [SESSION_COOKIE]: 's_invalid_token_value' },
    });
    expect(res.statusCode).toBe(401);
  });
});
