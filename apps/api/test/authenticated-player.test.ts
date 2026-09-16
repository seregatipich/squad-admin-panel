import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { players, roles, sessions } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  establishAuthenticatedPlayerSession,
  type PlayerIdentity,
} from '../src/lib/authenticated-player.js';
import * as firstOwner from '../src/lib/first-owner.js';
import { resetSetupState, testSteamId } from './helpers/snapshot-restore.js';
import { makeFakeBridge, runMigrations } from './integration/harness.js';
import { createIsolatedSchema } from './integration/isolated-db.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
const EXISTING_STEAM_ID = testSteamId(299_001);
const NEW_STEAM_ID = testSteamId(299_002);
const KEEP_AVATAR_STEAM_ID = testSteamId(299_003);
const EXPIRED_ROLE_STEAM_ID = testSteamId(299_004);

async function buildApp(dbUrl: string) {
  const app = Fastify({ logger: false });
  const sql = postgres(dbUrl, { max: 2, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: isolated integration database
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  let identity: PlayerIdentity = {
    steamId64: EXISTING_STEAM_ID,
    canonicalName: 'Patrego',
    avatarUrl: 'https://cdn.example/patrego.jpg',
  };
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  app.decorate('config', {
    SESSION_TTL_SECONDS: 21_600,
    // biome-ignore lint/suspicious/noExplicitAny: partial config for isolated helper test
  } as any);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  app.get('/establish', async (req, reply) => {
    await establishAuthenticatedPlayerSession(app, req, reply, identity);
    return reply;
  });
  await app.ready();
  return {
    app,
    db,
    redis,
    setIdentity: (next: PlayerIdentity) => {
      identity = next;
    },
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

describe('establishAuthenticatedPlayerSession', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp(schemaInfo.url);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('updates an existing identity and creates a panel session from current RBAC', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const roleId = uuidv7();
    const playerId = uuidv7();
    await h.db.insert(roles).values({ id: roleId, name: 'Panel Admin', panelAccess: true });
    await h.db.insert(players).values({
      id: playerId,
      steamId64: EXISTING_STEAM_ID,
      canonicalName: 'Old Name',
      canonicalNameNormalized: 'old name',
      avatarUrl: 'https://cdn.example/old.jpg',
      roleId,
    });

    const response = await h.app.inject({
      method: 'GET',
      url: '/establish',
      headers: { 'user-agent': 'login acceptance' },
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(String(response.headers['set-cookie'])).toMatch(
      /__Host-sid=s_.*; Max-Age=21600; Path=\/; HttpOnly; Secure; SameSite=Lax/u,
    );
    const player = await h.db
      .select()
      .from(players)
      .where(eq(players.steamId64, EXISTING_STEAM_ID))
      .limit(1);
    expect(player[0]).toMatchObject({
      id: playerId,
      canonicalName: 'Patrego',
      canonicalNameNormalized: 'patrego',
      avatarUrl: 'https://cdn.example/patrego.jpg',
    });
    const created = await h.db.select().from(sessions).where(eq(sessions.playerId, playerId));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scope: 'panel',
      ip: '192.0.2.10',
      userAgent: 'login acceptance',
    });
  });

  it('creates a new player with a self-service session after first-owner setup', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    h.setIdentity({
      steamId64: NEW_STEAM_ID,
      canonicalName: '[TAG] New Player',
      avatarUrl: null,
    });

    const response = await h.app.inject({ method: 'GET', url: '/establish' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/me');
    const player = await h.db
      .select()
      .from(players)
      .where(eq(players.steamId64, NEW_STEAM_ID))
      .limit(1);
    expect(player).toHaveLength(1);
    expect(player[0]?.canonicalNameNormalized).toBe('new player');
    const created = await h.db.select().from(sessions).where(eq(sessions.playerId, player[0]?.id));
    expect(created[0]?.scope).toBe('self_service');
  });

  it('does not erase an existing avatar when the site has no current avatar', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const playerId = uuidv7();
    await h.db.insert(players).values({
      id: playerId,
      steamId64: KEEP_AVATAR_STEAM_ID,
      canonicalName: 'Old Name',
      canonicalNameNormalized: 'old name',
      avatarUrl: 'https://cdn.example/keep.jpg',
    });
    h.setIdentity({
      steamId64: KEEP_AVATAR_STEAM_ID,
      canonicalName: 'Current Name',
      avatarUrl: null,
    });

    await h.app.inject({ method: 'GET', url: '/establish' });

    const player = await h.db.select().from(players).where(eq(players.id, playerId)).limit(1);
    expect(player[0]?.avatarUrl).toBe('https://cdn.example/keep.jpg');
  });

  it('uses an expired panel role as self-service authority', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const roleId = uuidv7();
    await h.db.insert(roles).values({ id: roleId, name: 'Expired Admin', panelAccess: true });
    await h.db.insert(players).values({
      id: uuidv7(),
      steamId64: EXPIRED_ROLE_STEAM_ID,
      canonicalName: 'Expired Admin',
      canonicalNameNormalized: 'expired admin',
      roleId,
      roleExpiresAt: new Date(Date.now() - 60_000),
    });
    h.setIdentity({
      steamId64: EXPIRED_ROLE_STEAM_ID,
      canonicalName: 'Expired Admin',
      avatarUrl: null,
    });

    const response = await h.app.inject({ method: 'GET', url: '/establish' });

    expect(response.headers.location).toBe('/me');
  });

  it('fails closed without an Owner role and does not create a session', async () => {
    vi.spyOn(firstOwner, 'claimFirstOwner').mockResolvedValue('no_owner_role');

    const response = await h.app.inject({ method: 'GET', url: '/establish' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'owner_role_missing' });
    expect(await h.db.select().from(sessions)).toHaveLength(0);
  });
});
