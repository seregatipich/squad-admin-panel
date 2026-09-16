import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { playerNameHistory, players, roles, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  scope: 'panel' | 'self_service' = 'panel',
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
    scope,
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
    vi.restoreAllMocks();
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

  it.each(['panel', 'self_service'] as const)(
    'revokes every local %s session on global logout without calling any external site',
    async (scope) => {
      const steamId64 = scope === 'panel' ? 76561198000000302n : 76561198000000303n;
      const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, steamId64, scope);
      await createSession(h.db, h.redis, {
        playerId,
        ip: '192.0.2.40',
        userAgent: 'second-device',
        ttlMs: 21600 * 1000,
        scope,
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout-all',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(
        await h.db.select().from(sessionsTable).where(eq(sessionsTable.playerId, playerId)),
      ).toEqual([]);
      expect(String(response.headers['set-cookie'])).toContain('__Host-sid=;');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects global logout without a session', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout-all' });

    expect(response.statusCode).toBe(401);
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

  it('omits sessions that have already expired', async () => {
    // Регрессия: карточка называется «Активные сессии» и обещает «устройства, с
    // которых сейчас открыта панель», а эндпоинт отдавал все строки игрока —
    // включая протухшие, с живой кнопкой «Завершить» напротив каждой.
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000402n);
    const live = await createSession(h.db, h.redis, {
      playerId,
      ip: '10.0.0.7',
      userAgent: 'live-ua',
      ttlMs: 21600 * 1000,
    });
    const expired = await createSession(h.db, h.redis, {
      playerId,
      ip: '10.0.0.8',
      userAgent: 'expired-ua',
      ttlMs: -60 * 1000,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(live.session.id);
    expect(ids).not.toContain(expired.session.id);
  });

  it('puts the current session first and orders the rest by last activity', async () => {
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000403n);
    const stale = await createSession(h.db, h.redis, {
      playerId,
      ip: '10.0.0.9',
      userAgent: 'stale-ua',
      ttlMs: 21600 * 1000,
    });
    const recent = await createSession(h.db, h.redis, {
      playerId,
      ip: '10.0.0.10',
      userAgent: 'recent-ua',
      ttlMs: 21600 * 1000,
    });
    // Момент последней активности проставляется явно: строки создаются в одну
    // миллисекунду, и порядок вставки ничего про активность не говорит.
    await h.db
      .update(sessionsTable)
      .set({ lastActivityAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(sessionsTable.id, stale.session.id));
    await h.db
      .update(sessionsTable)
      .set({ lastActivityAt: new Date(Date.now() - 1 * 3_600_000) })
      .where(eq(sessionsTable.id, recent.session.id));

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/sessions',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; current: boolean }>;
    expect(list[0]?.current).toBe(true);
    expect(list.slice(1).map((s) => s.id)).toEqual([recent.session.id, stale.session.id]);
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

describe('GET /api/v1/me/names', () => {
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
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/names' });
    expect(res.statusCode).toBe(401);
  });

  it('returns both names and the history newest first', async () => {
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000404n);
    await h.db.update(players).set({ personaName: 'SteamNick' }).where(eq(players.id, playerId));
    await h.db.insert(playerNameHistory).values([
      {
        playerId,
        name: 'OldestNick',
        nameNormalized: 'oldestnick',
        firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      {
        playerId,
        name: 'MiddleNick',
        nameNormalized: 'middlenick',
        firstSeenAt: new Date('2026-02-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      {
        playerId,
        name: 'TestPlayer',
        nameNormalized: 'testplayer',
        firstSeenAt: new Date('2026-06-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/names',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      canonical_name: string;
      persona_name: string | null;
      history: Array<{ name: string; first_seen_at: string; last_seen_at: string }>;
    };
    expect(body.canonical_name).toBe('TestPlayer');
    expect(body.persona_name).toBe('SteamNick');
    expect(body.history.map((entry) => entry.name)).toEqual([
      'TestPlayer',
      'MiddleNick',
      'OldestNick',
    ]);
    expect(body.history[0]?.last_seen_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns an empty history for a player who never changed a name', async () => {
    const { token } = await seedAuthedPlayer(h.db, h.redis, 76561198000000405n);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/names',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { persona_name: string | null; history: unknown[] };
    expect(body.persona_name).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("never leaks another player's names", async () => {
    const { token, playerId } = await seedAuthedPlayer(h.db, h.redis, 76561198000000406n);
    const [{ id: otherPlayerId }] = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000000407n,
        canonicalName: 'Stranger',
        canonicalNameNormalized: 'stranger',
      })
      .returning({ id: players.id });
    await h.db.insert(playerNameHistory).values([
      { playerId, name: 'MyOldNick', nameNormalized: 'myoldnick' },
      { playerId: otherPlayerId, name: 'StrangerNick', nameNormalized: 'strangernick' },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/names',
      cookies: { [SESSION_COOKIE]: token },
    });
    const body = res.json() as { history: Array<{ name: string }> };
    expect(body.history.map((entry) => entry.name)).toEqual(['MyOldNick']);
  });
});
