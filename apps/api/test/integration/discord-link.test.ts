import { playerDiscordLinks, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(979001);
const LINKER_STEAM = testSteamId(979002);
const OTHER_STEAM = testSteamId(979003);
const PLAIN_STEAM = testSteamId(979004);
const NO_ACCESS_STEAM = testSteamId(979005);

const STATE_COOKIE = '__Host-discord-state';
const STATE_REDIS_PREFIX = 'discord-oauth-state:';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

async function seedPlayerWithRole(opts: {
  steamId64: bigint;
  name: string;
  panelAccess: boolean;
  canAssignRoles: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `role-${opts.name}`,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canAssignRoles: opts.canAssignRoles,
  });
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: opts.name,
      canonicalNameNormalized: opts.name.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  return row.id;
}

async function seedPlainPlayer(steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  return row.id;
}

async function login(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'discord-link-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

/** Fakes the two Discord calls the callback makes: token exchange, then `users/@me`. */
function stubDiscord(user: { id: string; username: string; global_name?: string | null }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-access-token' }));
      }
      if (url.includes('/users/@me')) {
        return new Response(JSON.stringify({ global_name: null, ...user }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

/** Drives `GET /auth/discord/login` and returns the issued state (cookie + Redis are live). */
async function startLogin(cookie: string): Promise<string> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/auth/discord/login',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.location as string);
  const state = location.searchParams.get('state');
  if (!state) throw new Error('login did not issue a state');
  return state;
}

function callbackUrl(state: string, code = 'auth-code-1'): string {
  return `/api/v1/auth/discord/callback?code=${code}&state=${encodeURIComponent(state)}`;
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (h) await h.cleanup();
});

describeIfDb('GET /api/v1/auth/discord/login', () => {
  it('redirects an authenticated player to Discord with scope=identify and stores the state', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/discord/login',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('scope')).toBe('identify');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://panel.test/api/v1/auth/discord/callback',
    );

    const state = location.searchParams.get('state') as string;
    const setCookie = res.headers['set-cookie'];
    const flat = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(flat).toContain(`${STATE_COOKIE}=${state}`);
    expect(flat).toMatch(/HttpOnly/i);

    const stored = await h.redis.get(`${STATE_REDIS_PREFIX}${state}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toMatchObject({ playerId });
    const ttl = await h.redis.ttl(`${STATE_REDIS_PREFIX}${state}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('rejects an anonymous caller with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/discord/login' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('answers 503 oauth_not_configured when the Discord client id is absent', async () => {
    const cookie = await loginAsOwner(h);
    const saved = h.app.config.DISCORD_CLIENT_ID;
    h.app.config.DISCORD_CLIENT_ID = undefined;
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/auth/discord/login',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'oauth_not_configured' });
    } finally {
      h.app.config.DISCORD_CLIENT_ID = saved;
    }
  });
});

describeIfDb('GET /api/v1/auth/discord/callback', () => {
  it('links the Discord account, writes an audit row and redirects to the player card', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    const state = await startLogin(cookie);
    stubDiscord({ id: '111222333444555666', username: 'squaddie', global_name: 'Сквадди' });

    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=${state}` },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/players/${playerId}`);

    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].discordUserId).toBe('111222333444555666');
    expect(rows[0].discordUsername).toBe('Сквадди');

    await assertAuditRow(h, {
      action: 'integration.discord.link',
      resource: 'player_discord_link',
      targetId: playerId,
    });

    // The state is single-use: the Redis record is consumed by the callback.
    expect(await h.redis.get(`${STATE_REDIS_PREFIX}${state}`)).toBeNull();
  });

  it('rejects a forged state with 403 and creates no link', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    await startLogin(cookie);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });

    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl('forged-state'),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=some-other-state` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'state_mismatch' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, playerId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a state that matches the cookie but was never issued with 400 state_expired', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });

    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl('never-issued'),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=never-issued` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'state_expired' });
  });

  it('rejects a state issued for a different player with 403', async () => {
    const linkerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const otherId = await seedPlayerWithRole({
      steamId64: OTHER_STEAM,
      name: 'Other',
      panelAccess: true,
      canAssignRoles: false,
    });
    const linkerCookie = await login(linkerId);
    const otherCookie = await login(otherId);
    const state = await startLogin(linkerCookie);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });

    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${otherCookie}; ${STATE_COOKIE}=${state}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'state_mismatch' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, otherId));
    expect(rows).toHaveLength(0);
  });

  it('rejects an anonymous callback with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: callbackUrl('anything') });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects the same Discord account on a second player with 409 already_linked_other', async () => {
    const firstId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const secondId = await seedPlayerWithRole({
      steamId64: OTHER_STEAM,
      name: 'Other',
      panelAccess: true,
      canAssignRoles: false,
    });
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });

    const firstCookie = await login(firstId);
    const firstState = await startLogin(firstCookie);
    const first = await h.app.inject({
      method: 'GET',
      url: callbackUrl(firstState),
      headers: { cookie: `${firstCookie}; ${STATE_COOKIE}=${firstState}` },
    });
    expect(first.statusCode).toBe(302);

    const secondCookie = await login(secondId);
    const secondState = await startLogin(secondCookie);
    const second = await h.app.inject({
      method: 'GET',
      url: callbackUrl(secondState),
      headers: { cookie: `${secondCookie}; ${STATE_COOKIE}=${secondState}` },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'already_linked_other' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, secondId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a second link for an already-linked player with 409 already_linked_self', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });
    const firstState = await startLogin(cookie);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: callbackUrl(firstState),
          headers: { cookie: `${cookie}; ${STATE_COOKIE}=${firstState}` },
        })
      ).statusCode,
    ).toBe(302);

    stubDiscord({ id: '999888777666555444', username: 'second-account' });
    const secondState = await startLogin(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl(secondState),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=${secondState}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'already_linked_self' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].discordUserId).toBe('111222333444555666');
  });

  it('answers 502 discord_exchange_failed when Discord rejects the token exchange', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    const state = await startLogin(cookie);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );

    const res = await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=${state}` },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'discord_exchange_failed' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, playerId));
    expect(rows).toHaveLength(0);
  });
});

describeIfDb('GET /api/v1/players/:playerId/discord', () => {
  it('returns the link snapshot for a panel user with player:view', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie', global_name: 'Сквадди' });
    const state = await startLogin(cookie);
    await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=${state}` },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/discord`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      linked: boolean;
      discord_user_id: string | null;
      discord_username: string | null;
      linked_at: string | null;
    };
    expect(body.linked).toBe(true);
    expect(body.discord_user_id).toBe('111222333444555666');
    expect(body.discord_username).toBe('Сквадди');
    expect(body.linked_at).not.toBeNull();
  });

  it('returns linked=false with null fields for an unlinked player', async () => {
    const targetId = await seedPlainPlayer(PLAIN_STEAM, 'Plain');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/discord`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      linked: false,
      discord_user_id: null,
      discord_username: null,
      linked_at: null,
    });
  });

  it('is 403 for a session without panel access', async () => {
    const targetId = await seedPlainPlayer(PLAIN_STEAM, 'Plain');
    const strangerId = await seedPlayerWithRole({
      steamId64: NO_ACCESS_STEAM,
      name: 'NoAccess',
      panelAccess: false,
      canAssignRoles: false,
    });
    const cookie = await login(strangerId);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/discord`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it('is 401 without a session', async () => {
    const targetId = await seedPlainPlayer(PLAIN_STEAM, 'Plain');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/discord`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('DELETE /api/v1/players/me/discord/link', () => {
  it('removes the caller own link and writes an unlink audit row', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });
    const state = await startLogin(cookie);
    await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${cookie}; ${STATE_COOKIE}=${state}` },
    });

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/players/me/discord/link',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, playerId));
    expect(rows).toHaveLength(0);

    await assertAuditRow(h, {
      action: 'integration.discord.unlink',
      resource: 'player_discord_link',
    });
  });

  it('is 404 not_linked when the caller has no link', async () => {
    const playerId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const cookie = await login(playerId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/players/me/discord/link',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_linked' });
  });

  it('is 401 without a session', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/players/me/discord/link',
    });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('DELETE /api/v1/players/:playerId/discord/link', () => {
  it('lets a can_assign_roles admin force-unlink another player and audits it', async () => {
    const victimId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const victimCookie = await login(victimId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });
    const state = await startLogin(victimCookie);
    await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${victimCookie}; ${STATE_COOKIE}=${state}` },
    });

    const ownerCookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${victimId}/discord/link`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, victimId));
    expect(rows).toHaveLength(0);

    await assertAuditRow(h, {
      action: 'integration.discord.unlink',
      resource: 'player_discord_link',
      targetId: victimId,
    });
  });

  it('is 403 for a panel user without can_assign_roles and leaves the link intact', async () => {
    const victimId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const victimCookie = await login(victimId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });
    const state = await startLogin(victimCookie);
    await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${victimCookie}; ${STATE_COOKIE}=${state}` },
    });

    const weakId = await seedPlayerWithRole({
      steamId64: OTHER_STEAM,
      name: 'WeakAdmin',
      panelAccess: true,
      canAssignRoles: false,
    });
    const weakCookie = await login(weakId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${victimId}/discord/link`,
      headers: { cookie: weakCookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
    const rows = await h.db
      .select()
      .from(playerDiscordLinks)
      .where(eq(playerDiscordLinks.playerId, victimId));
    expect(rows).toHaveLength(1);
  });

  it('is 404 not_linked when the target player has no link', async () => {
    const targetId = await seedPlainPlayer(PLAIN_STEAM, 'Plain');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${targetId}/discord/link`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_linked' });
  });

  it('is 401 without a session', async () => {
    const targetId = await seedPlainPlayer(PLAIN_STEAM, 'Plain');
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${targetId}/discord/link`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('GET /api/v1/users discord badge', () => {
  it('reports discord_linked for linked and unlinked panel users', async () => {
    const linkedId = await seedPlayerWithRole({
      steamId64: LINKER_STEAM,
      name: 'Linker',
      panelAccess: true,
      canAssignRoles: false,
    });
    const unlinkedId = await seedPlayerWithRole({
      steamId64: OTHER_STEAM,
      name: 'Unlinked',
      panelAccess: true,
      canAssignRoles: false,
    });
    const linkedCookie = await login(linkedId);
    stubDiscord({ id: '111222333444555666', username: 'squaddie' });
    const state = await startLogin(linkedCookie);
    await h.app.inject({
      method: 'GET',
      url: callbackUrl(state),
      headers: { cookie: `${linkedCookie}; ${STATE_COOKIE}=${state}` },
    });

    const ownerCookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: string; discord_linked: boolean }[];
    expect(rows.find((r) => r.id === linkedId)?.discord_linked).toBe(true);
    expect(rows.find((r) => r.id === unlinkedId)?.discord_linked).toBe(false);
    // The list surface must never carry the raw Discord identifier.
    expect(res.body).not.toContain('discord_user_id');
    expect(res.body).not.toContain('111222333444555666');
  });
});
