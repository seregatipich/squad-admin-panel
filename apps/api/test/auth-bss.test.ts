import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import * as schema from '@squad/db/schema';
import { auditLog, players, roles, sessions } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldDisableSensitiveAuthRequestLogging } from '../src/lib/logger.js';
import { createSession } from '../src/lib/sessions.js';
import auditPlugin from '../src/plugins/audit.js';
import requestContextPlugin from '../src/plugins/request-context.js';
import bssAuthRoutes from '../src/routes/auth-bss.js';
import { resetSetupState, testSteamId } from './helpers/snapshot-restore.js';
import { makeFakeBridge, runMigrations } from './integration/harness.js';
import { createIsolatedSchema } from './integration/isolated-db.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
const CLIENT_ID = 'squad-admin-panel';
const CURRENT_SECRET = 'c'.repeat(32);
const NEXT_SECRET = 'd'.repeat(32);
const PANEL_STEAM_ID = testSteamId(299_101);
const SELF_SERVICE_STEAM_ID = testSteamId(299_102);
const REVOKE_STEAM_ID = testSteamId(299_103);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function buildApp(dbUrl: string) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const app = Fastify({
    logger: { level: 'info', stream },
    disableRequestLogging: shouldDisableSensitiveAuthRequestLogging,
  });
  const sql = postgres(dbUrl, { max: 2, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: isolated integration database
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  const published: unknown[] = [];
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  app.decorate('liveBus', {
    publish: (event: unknown) => published.push(event),
    subscribe: () => () => undefined,
  });
  app.decorate('config', {
    BSS_SITE_URL: 'https://bss.games',
    BSS_SSO_CLIENT_ID: CLIENT_ID,
    BSS_SSO_CLIENT_SECRET: CURRENT_SECRET,
    BSS_SSO_CLIENT_SECRET_NEXT: NEXT_SECRET,
    PANEL_PUBLIC_URL: 'https://panel.example',
    SESSION_TTL_SECONDS: 21_600,
    // biome-ignore lint/suspicious/noExplicitAny: partial config for isolated route test
  } as any);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await app.register(rateLimit, { max: 1_200, timeWindow: '1 minute' });
  await app.register(requestContextPlugin);
  await app.register(auditPlugin);
  await app.register(bssAuthRoutes);
  await app.ready();
  return {
    app,
    db,
    redis,
    logs,
    published,
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

function cookieValue(response: Awaited<ReturnType<ReturnType<typeof Fastify>['inject']>>): string {
  const header = response.headers['set-cookie'];
  const flat = Array.isArray(header) ? header.join('\n') : String(header ?? '');
  const match = /__Host-bss-state=([^;]+)/u.exec(flat);
  if (!match?.[1]) throw new Error('state cookie missing');
  return match[1];
}

describe('BSS authentication routes', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp(schemaInfo.url);
  });

  afterAll(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  beforeEach(async () => {
    h.logs.length = 0;
    h.published.length = 0;
    await h.redis.flushdb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        steam_id64: String(SELF_SERVICE_STEAM_ID),
        canonical_name: 'BSS Player',
        avatar_url: null,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function beginLogin(ip: string) {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/bss/login',
      remoteAddress: ip,
    });
    const location = new URL(String(response.headers.location));
    const state = location.searchParams.get('state');
    if (!state) throw new Error('state missing');
    return { response, location, state, cookie: cookieValue(response) };
  }

  async function completeLogin(input: {
    state: string;
    cookie: string;
    code?: string;
    ip: string;
  }) {
    return h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/bss/callback?code=${encodeURIComponent(input.code ?? 'code_01234567890123456789012345678901234567')}&state=${encodeURIComponent(input.state)}`,
      cookies: { '__Host-bss-state': input.cookie },
      remoteAddress: input.ip,
    });
  }

  it('stores only a hashed state key and redirects with an exact PKCE request', async () => {
    const started = await beginLogin('192.0.2.1');

    expect(started.response.statusCode).toBe(302);
    expect(`${started.location.origin}${started.location.pathname}`).toBe(
      'https://bss.games/auth/sso/authorize',
    );
    expect(Object.fromEntries(started.location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'https://panel.example/api/v1/auth/bss/callback',
      code_challenge_method: 'S256',
      state: started.state,
    });
    expect(started.location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(String(started.response.headers['set-cookie'])).toMatch(
      /__Host-bss-state=.*; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Lax/u,
    );
    expect(await h.redis.get(`bss-state:${digest(started.state)}`)).toMatch(
      /^[A-Za-z0-9._~-]{43,128}$/u,
    );
    expect(await h.redis.keys(`*${started.state}*`)).toEqual([]);
  });

  it('rejects mismatched and expired state and clears the cookie', async () => {
    const started = await beginLogin('192.0.2.2');
    const mismatch = await completeLogin({
      ...started,
      state: `${started.state.startsWith('A') ? 'B' : 'A'}${started.state.slice(1)}`,
      ip: '192.0.2.3',
    });
    expect(mismatch.statusCode).toBe(302);
    expect(mismatch.headers.location).toBe('/login?error=sso_failed');
    expect(String(mismatch.headers['set-cookie'])).toContain('__Host-bss-state=;');

    await h.redis.del(`bss-state:${digest(started.state)}`);
    const expired = await completeLogin({ ...started, ip: '192.0.2.4' });
    expect(expired.headers.location).toBe('/login?error=sso_failed');
  });

  it('exchanges once, establishes a panel session and rejects replay', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const roleId = uuidv7();
    const playerId = uuidv7();
    await h.db.insert(roles).values({ id: roleId, name: 'BSS Panel', panelAccess: true });
    await h.db.insert(players).values({
      id: playerId,
      steamId64: PANEL_STEAM_ID,
      canonicalName: 'Panel User',
      canonicalNameNormalized: 'panel user',
      roleId,
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        steam_id64: String(PANEL_STEAM_ID),
        canonical_name: 'Current Panel User',
        avatar_url: null,
      }),
    );
    const started = await beginLogin('192.0.2.5');

    const accepted = await completeLogin({ ...started, ip: '192.0.2.6' });

    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe('/');
    expect(String(accepted.headers['set-cookie'])).toContain('__Host-sid=s_');
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CURRENT_SECRET,
      code: 'code_01234567890123456789012345678901234567',
      redirect_uri: 'https://panel.example/api/v1/auth/bss/callback',
    });
    const created = await h.db.select().from(sessions).where(eq(sessions.playerId, playerId));
    expect(created[0]?.scope).toBe('panel');

    const replay = await completeLogin({ ...started, ip: '192.0.2.7' });
    expect(replay.headers.location).toBe('/login?error=sso_failed');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('rechecks a role changed between authorize and callback', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const roleId = uuidv7();
    await h.db.insert(roles).values({ id: roleId, name: 'Soon Expired', panelAccess: true });
    await h.db.insert(players).values({
      id: uuidv7(),
      steamId64: SELF_SERVICE_STEAM_ID,
      canonicalName: 'Soon Expired',
      canonicalNameNormalized: 'soon expired',
      roleId,
    });
    const started = await beginLogin('192.0.2.8');
    await h.db
      .update(players)
      .set({ roleExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(players.steamId64, SELF_SERVICE_STEAM_ID));

    const response = await completeLogin({ ...started, ip: '192.0.2.9' });

    expect(response.headers.location).toBe('/me');
  });

  it.each([CURRENT_SECRET, NEXT_SECRET])(
    'accepts a trusted site logout with a rotation secret',
    async (clientSecret) => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/bss/logout-all',
        payload: {
          client_id: CLIENT_ID,
          client_secret: clientSecret,
          steam_id64: String(testSteamId(299_199)),
        },
        remoteAddress: `192.0.2.${clientSecret === CURRENT_SECRET ? '10' : '11'}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    },
  );

  it('revokes every local session idempotently without putting SteamID in audit', async () => {
    const playerId = uuidv7();
    await h.db.insert(players).values({
      id: playerId,
      steamId64: REVOKE_STEAM_ID,
      canonicalName: 'Revoke Player',
      canonicalNameNormalized: 'revoke player',
    });
    await createSession(h.db, h.redis, {
      playerId,
      ip: null,
      userAgent: null,
      ttlMs: 60_000,
    });
    await createSession(h.db, h.redis, {
      playerId,
      ip: null,
      userAgent: null,
      ttlMs: 60_000,
    });
    const payload = {
      client_id: CLIENT_ID,
      client_secret: CURRENT_SECRET,
      steam_id64: String(REVOKE_STEAM_ID),
    };

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bss/logout-all',
      payload,
      remoteAddress: '192.0.2.12',
    });
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bss/logout-all',
      payload,
      remoteAddress: '192.0.2.13',
    });

    expect(first.json()).toEqual({ ok: true });
    expect(second.json()).toEqual({ ok: true });
    expect(await h.db.select().from(sessions).where(eq(sessions.playerId, playerId))).toEqual([]);
    expect(h.published).toHaveLength(2);
    const audits = await h.db.select().from(auditLog);
    expect(
      JSON.stringify(audits, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain(String(REVOKE_STEAM_ID));
  });

  it('enforces separate callback and trusted-revoke limits', async () => {
    const callbackResponses = [];
    for (let index = 0; index < 11; index += 1) {
      callbackResponses.push(
        await h.app.inject({
          method: 'GET',
          url: `/api/v1/auth/bss/callback?code=code-${index}&state=state_01234567890123456789012345678901`,
          cookies: { '__Host-bss-state': 'mismatch' },
          remoteAddress: '192.0.2.20',
        }),
      );
    }
    const revokeResponses = [];
    for (let index = 0; index < 6; index += 1) {
      revokeResponses.push(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/bss/logout-all',
          payload: {
            client_id: CLIENT_ID,
            client_secret: CURRENT_SECRET,
            steam_id64: String(testSteamId(299_299)),
          },
          remoteAddress: '192.0.2.21',
        }),
      );
    }

    expect(callbackResponses[9]?.statusCode).toBe(302);
    expect(callbackResponses[10]?.statusCode).toBe(429);
    expect(revokeResponses[4]?.statusCode).toBe(200);
    expect(revokeResponses[5]?.statusCode).toBe(429);
  });

  it('never writes callback code, state or SteamID to logs or audit', async () => {
    await resetSetupState(h.db, { firstOwnerClaimed: true });
    const sentinelCode = 'sentinel-code-must-never-be-logged';
    const started = await beginLogin('192.0.2.30');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        steam_id64: String(testSteamId(299_399)),
        canonical_name: 'Private Identity',
        avatar_url: null,
      }),
    );

    const response = await completeLogin({
      ...started,
      code: sentinelCode,
      ip: '192.0.2.31',
    });

    expect(response.statusCode).toBe(302);
    const serializedLogs = h.logs.join('');
    expect(serializedLogs).not.toContain(sentinelCode);
    expect(serializedLogs).not.toContain(started.state);
    expect(serializedLogs).not.toContain(String(testSteamId(299_399)));
    const audits = await h.db.select().from(auditLog);
    const serializedAudits = JSON.stringify(audits, (_key, value) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(serializedAudits).not.toContain(sentinelCode);
    expect(serializedAudits).not.toContain(started.state);
    expect(serializedAudits).not.toContain(String(testSteamId(299_399)));
  });

  it('sanitizes a callback dependency failure before the global error handler', async () => {
    const sentinelCode = 'sentinel-dependency-code-must-not-leak';
    const sentinelFailure = 'sentinel-internal-failure-must-not-leak';
    const started = await beginLogin('192.0.2.32');
    vi.spyOn(h.redis, 'getdel').mockRejectedValueOnce(new Error(sentinelFailure));
    h.logs.length = 0;

    const response = await completeLogin({
      ...started,
      code: sentinelCode,
      ip: '192.0.2.33',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=sso_failed');
    expect(h.logs.join('')).not.toContain(sentinelCode);
    expect(h.logs.join('')).not.toContain(started.state);
    expect(h.logs.join('')).not.toContain(sentinelFailure);
  });

  it('returns a recoverable login page when the accepted identity cannot create a session', async () => {
    const started = await beginLogin('192.0.2.34');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        steam_id64: String(testSteamId(299_499)),
        canonical_name: '   ',
        avatar_url: null,
      }),
    );

    const response = await completeLogin({ ...started, ip: '192.0.2.35' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=sso_failed');
  });
});
