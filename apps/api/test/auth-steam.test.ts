import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { panelMeta, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import steamRoutes from '../src/routes/auth-steam.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from './integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function buildApp(opts: { dbUrl: string }) {
  const app = Fastify({ logger: false });
  const sql = postgres(opts.dbUrl, { max: 2, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: integration test type coercion
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  app.decorate('config', {
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
    // biome-ignore lint/suspicious/noExplicitAny: partial config for isolated route test
  } as any);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await app.register(steamRoutes);
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

describe('GET /api/v1/auth/steam/login', () => {
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

  it('redirects to steam with nonce in cookie + query', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/steam/login' });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('steamcommunity.com/openid/login');
    const cookieHeader = (res.headers['set-cookie'] ?? '') as string | string[];
    const flat = Array.isArray(cookieHeader) ? cookieHeader.join('\n') : cookieHeader;
    expect(flat).toMatch(/__Host-steam-nonce=[\w-]+/);
    expect(location).toMatch(/openid\.return_to=.*n%3D[\w-]+/);
  });
});

describe('GET /api/v1/auth/steam/callback', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('is_valid:true\n', { status: 200 });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('rejects when nonce cookie missing', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/steam/callback?n=abc',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when query nonce does not match cookie', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/steam/callback?n=mismatch',
      cookies: { '__Host-steam-nonce': 'expected' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when redis nonce missing (expired)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/steam/callback?n=neverstored',
      cookies: { '__Host-steam-nonce': 'neverstored' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('first-login owner happy path: creates session + sets cookie', async () => {
    const NONCE = 'happy-nonce';
    await h.redis.set(
      `steam-nonce:${NONCE}`,
      JSON.stringify({ ts: Date.now(), ip: null }),
      'EX',
      300,
    );
    const url = new URL(`https://panel.test/api/v1/auth/steam/callback?n=${NONCE}`);
    url.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
    url.searchParams.set('openid.mode', 'id_res');
    url.searchParams.set(
      'openid.claimed_id',
      'https://steamcommunity.com/openid/id/76561198000000099',
    );
    url.searchParams.set(
      'openid.identity',
      'https://steamcommunity.com/openid/id/76561198000000099',
    );
    url.searchParams.set(
      'openid.return_to',
      `https://panel.test/api/v1/auth/steam/callback?n=${NONCE}`,
    );
    url.searchParams.set('openid.response_nonce', '2026-04-25T12:00:00Zhappy');
    url.searchParams.set('openid.assoc_handle', 'x');
    url.searchParams.set('openid.signed', 'signed,op_endpoint');
    url.searchParams.set('openid.sig', 'sig');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${url.searchParams.toString()}`,
      cookies: { '__Host-steam-nonce': NONCE },
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toBe('/');
    const cookieHeader = (res.headers['set-cookie'] ?? '') as string | string[];
    const flat = Array.isArray(cookieHeader) ? cookieHeader.join('\n') : cookieHeader;
    expect(flat).toMatch(/__Host-sid=s_/);
  });

  it('replay rejected: same response_nonce can only be used once', async () => {
    const NONCE_A = 'replay-a';
    const NONCE_B = 'replay-b';
    const RESP_NONCE = '2026-04-25T12:00:00Zreplay';
    const buildUrl = (n: string) => {
      const u = new URLSearchParams({
        n,
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'id_res',
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000100',
        'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000100',
        'openid.return_to': `https://panel.test/api/v1/auth/steam/callback?n=${n}`,
        'openid.response_nonce': RESP_NONCE,
        'openid.assoc_handle': 'x',
        'openid.signed': 'signed,op_endpoint',
        'openid.sig': 'sig',
      });
      return u.toString();
    };
    await h.redis.del(`steam-response-nonce:${RESP_NONCE}`);
    await h.redis.set(`steam-nonce:${NONCE_A}`, '{}', 'EX', 300);
    await h.redis.set(`steam-nonce:${NONCE_B}`, '{}', 'EX', 300);

    const first = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${buildUrl(NONCE_A)}`,
      cookies: { '__Host-steam-nonce': NONCE_A },
    });
    expect(first.statusCode).toBe(302);

    const replay = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${buildUrl(NONCE_B)}`,
      cookies: { '__Host-steam-nonce': NONCE_B },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('return_to host mismatch is rejected', async () => {
    const NONCE = 'returnto-attack';
    await h.redis.set(`steam-nonce:${NONCE}`, '{}', 'EX', 300);
    const u = new URLSearchParams({
      n: NONCE,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000101',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000101',
      'openid.return_to': `https://attacker.example/api/v1/auth/steam/callback?n=${NONCE}`,
      'openid.response_nonce': '2026-04-25T12:00:00Zreturnto',
      'openid.signed': 'signed,op_endpoint',
      'openid.sig': 'sig',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${u.toString()}`,
      cookies: { '__Host-steam-nonce': NONCE },
    });
    expect(res.statusCode).toBe(400);
  });

  it('player without role lands on /no-access with reason=no_role (when sentinel already claimed)', async () => {
    await h.db.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));
    const NONCE = 'noaccess-nonce';
    await h.redis.set(`steam-nonce:${NONCE}`, '{}', 'EX', 300);
    const u = new URLSearchParams({
      n: NONCE,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000200',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000200',
      'openid.return_to': `https://panel.test/api/v1/auth/steam/callback?n=${NONCE}`,
      'openid.response_nonce': '2026-04-25T12:00:00Znoaccess',
      'openid.signed': 'signed,op_endpoint',
      'openid.sig': 'sig',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${u.toString()}`,
      cookies: { '__Host-steam-nonce': NONCE },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/no-access?steam_id64=76561198000000200&reason=no_role');
    const cookieHeader = (res.headers['set-cookie'] ?? '') as string | string[];
    const flat = Array.isArray(cookieHeader) ? cookieHeader.join('\n') : cookieHeader;
    expect(flat).not.toMatch(/__Host-sid=/);
  });

  it('player whose role lacks panel access lands on /no-access with reason=role_no_access', async () => {
    await h.db.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));

    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: 'No Panel Access',
      panelAccess: false,
    });
    await h.db.insert(players).values({
      id: uuidv7(),
      steamId64: 76561198000000201n,
      canonicalName: 'RoleLackingAccess',
      canonicalNameNormalized: 'rolelackingaccess',
      roleId,
    });

    const NONCE = 'roleaccess-nonce';
    await h.redis.set(`steam-nonce:${NONCE}`, '{}', 'EX', 300);
    const u = new URLSearchParams({
      n: NONCE,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000201',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000201',
      'openid.return_to': `https://panel.test/api/v1/auth/steam/callback?n=${NONCE}`,
      'openid.response_nonce': '2026-04-25T12:00:00Zroleaccess',
      'openid.signed': 'signed,op_endpoint',
      'openid.sig': 'sig',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/steam/callback?${u.toString()}`,
      cookies: { '__Host-steam-nonce': NONCE },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      '/no-access?steam_id64=76561198000000201&reason=role_no_access',
    );
    const cookieHeader = (res.headers['set-cookie'] ?? '') as string | string[];
    const flat = Array.isArray(cookieHeader) ? cookieHeader.join('\n') : cookieHeader;
    expect(flat).not.toMatch(/__Host-sid=/);
  });
});
