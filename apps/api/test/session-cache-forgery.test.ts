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
import { createSession, mintSessionToken, resolveSession } from '../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import liveBusPlugin from '../src/plugins/live-bus.js';
import authRoutes from '../src/routes/auth.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from './integration/harness.js';

// Regression tests for #32 (findings #1025, #1032, #1263): anything that can
// reach Redis (a host-network game server, mod or sidecar) could write
// `session:<sha256(token)>` for a token of its choosing, or rewrite the
// playerId of an existing entry, and the API trusted the cache over the
// database. A cache entry must now carry a MAC the attacker cannot compute;
// one without it is ignored and the session is resolved from Postgres.

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function buildApp(dbUrl: string) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const sql = postgres(dbUrl, { max: 4, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: integration test
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge() as never);
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
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
async function seedOwner(db: any, steamId64: bigint): Promise<string> {
  const [ownerRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const [{ id }] = await db
    .insert(players)
    .values({
      steamId64,
      canonicalName: `Player${steamId64}`,
      canonicalNameNormalized: `player${steamId64}`,
      roleId: ownerRole.id,
    })
    .returning({ id: players.id });
  return id;
}

function forgedEntry(playerId: string): string {
  const now = Date.now();
  return JSON.stringify({
    playerId,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    lastActivityAt: new Date(now).toISOString(),
    ip: null,
    userAgent: 'attacker',
    scope: 'panel',
  });
}

describe('session cache forgery (#32)', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp(schemaInfo.url);
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('rejects a cache entry planted for a token that has no session row', async () => {
    const ownerId = await seedOwner(h.db, 76561198000032001n);
    const { token, tokenId } = mintSessionToken();
    await h.redis.set(`session:${tokenId}`, forgedEntry(ownerId), 'EX', 600);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(res.statusCode).toBe(401);
    expect(await resolveSession(h.db, h.redis, token)).toBeNull();
  });

  it('ignores a cache entry whose playerId was rewritten and resolves the real owner', async () => {
    const victimId = await seedOwner(h.db, 76561198000032002n);
    const attackerId = await seedOwner(h.db, 76561198000032003n);
    const { token, session } = await createSession(h.db, h.redis, {
      playerId: attackerId,
      ip: null,
      userAgent: 'ua',
      ttlMs: 3_600_000,
    });
    await h.redis.set(`session:${session.id}`, forgedEntry(victimId), 'EX', 600);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { steam_id64: string }).steam_id64).toBe('76561198000032003');
  });

  it('rejects a signed entry copied onto another token id', async () => {
    const ownerId = await seedOwner(h.db, 76561198000032004n);
    const { session } = await createSession(h.db, h.redis, {
      playerId: ownerId,
      ip: null,
      userAgent: 'ua',
      ttlMs: 3_600_000,
    });
    const signed = await h.redis.get(`session:${session.id}`);
    expect(signed).not.toBeNull();
    const { token, tokenId } = mintSessionToken();
    await h.redis.set(`session:${tokenId}`, signed as string, 'EX', 600);

    expect(await resolveSession(h.db, h.redis, token)).toBeNull();
  });

  it('still serves a legitimate session from its signed cache entry', async () => {
    const ownerId = await seedOwner(h.db, 76561198000032005n);
    const { token, session } = await createSession(h.db, h.redis, {
      playerId: ownerId,
      ip: null,
      userAgent: 'ua',
      ttlMs: 3_600_000,
    });
    // With the row gone, only a cache hit can still resolve the session.
    await h.db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));

    const resolved = await resolveSession(h.db, h.redis, token);

    expect(resolved?.playerId).toBe(ownerId);
    expect(resolved?.id).toBe(session.id);
    expect(resolved?.scope).toBe('panel');
  });
});
