import { moderationActions, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Mirrors the exact line grammar `parseSquadBansCfg` (CBAN-2,
// apps/workers/ban-sync/src/adapters/squad-bans-cfg.ts) consumes — replicated
// inline rather than importing the worker package (not a dependency of
// @squad/api) to prove our squad_cfg output round-trips through it.
const SQUAD_BANS_CFG_LINE_PATTERN =
  /^(?<prefix>.*?)Banned:(?<steamId>\d{17}):(?<expiry>\d+)\s*(?:\/\/\s*(?<comment>.*))?$/;

const OWNER_STEAM = testSteamId(110001);
const MANAGER_STEAM = testSteamId(110002);
const OUTSIDER_STEAM = testSteamId(110003);

const PERM_STEAM = testSteamId(110010);
const FUTURE_STEAM = testSteamId(110011);
const EXPIRED_STEAM = testSteamId(110012);
const REVERTED_STEAM = testSteamId(110013);
const EOS_ONLY_ID = 'eos-test-110014';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let managerCookie: string;
let outsiderCookie: string;

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  panelAccess: boolean;
  canManageBanSources: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canManageBanSources: opts.canManageBanSources,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  await h.db.insert(players).values({
    steamId64: opts.steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
}

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function mintToken(cookie: string, scopes: string[]): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/me/tokens',
    headers: { cookie },
    payload: { name: `federation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, scopes },
  });
  if (res.statusCode !== 201) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { plaintext: string }).plaintext;
}

async function seedBanTarget(steamId64: bigint | null, eosId: string | null): Promise<string> {
  const stub = steamId64 ? `Banned${String(steamId64).slice(-4)}` : `BannedEos${eosId}`;
  const inserted = await h.db
    .insert(players)
    .values({
      steamId64,
      eosId,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
    })
    .returning({ id: players.id });
  // biome-ignore lint/style/noNonNullAssertion: row was just inserted
  return inserted[0]!.id;
}

async function insertBan(opts: {
  playerId: string;
  banLength: string;
  reason?: string;
  createdAt?: Date;
  revertedAt?: Date | null;
}): Promise<void> {
  await h.db.insert(moderationActions).values({
    playerId: opts.playerId,
    actionType: 'ban',
    authorSystemLabel: 'test-harness',
    reason: opts.reason ?? 'cheating',
    context: { ban_length: opts.banLength },
    createdAt: opts.createdAt ?? new Date(),
    revertedAt: opts.revertedAt ?? null,
  });
}

async function setPublicationSettings(
  cookie: string,
  body: { enabled: boolean; publish_scope: 'all_active' | 'permanent_only' },
): Promise<void> {
  const res = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/settings/banlist-publication',
    headers: { cookie },
    payload: body,
  });
  if (res.statusCode !== 200) {
    throw new Error(`settings PUT failed: ${res.statusCode} ${res.body}`);
  }
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'FederationOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
  await seedRoleWithPlayer({
    roleName: 'BanlistManager',
    steamId64: MANAGER_STEAM,
    panelAccess: true,
    canManageBanSources: true,
  });
  await seedRoleWithPlayer({
    roleName: 'BanlistOutsider',
    steamId64: OUTSIDER_STEAM,
    panelAccess: true,
    canManageBanSources: false,
  });
  managerCookie = await loginAsSteam(MANAGER_STEAM, 'banlist-manager');
  outsiderCookie = await loginAsSteam(OUTSIDER_STEAM, 'banlist-outsider');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET/PUT /api/v1/settings/banlist-publication (RBAC)', () => {
  it('401 without a session', async () => {
    const get = await h.app.inject({ method: 'GET', url: '/api/v1/settings/banlist-publication' });
    expect(get.statusCode).toBe(401);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/banlist-publication',
      payload: { enabled: true, publish_scope: 'all_active' },
    });
    expect(put.statusCode).toBe(401);
  });

  it('403 for a panel user without can_manage_ban_sources', async () => {
    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/banlist-publication',
      headers: { cookie: outsiderCookie },
    });
    expect(get.statusCode).toBe(403);
    expect(get.json().error).toBe('forbidden');

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/banlist-publication',
      headers: { cookie: outsiderCookie },
      payload: { enabled: true, publish_scope: 'all_active' },
    });
    expect(put.statusCode).toBe(403);
  });

  it('a manager can read defaults and the PUT writes an audit row', async () => {
    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/banlist-publication',
      headers: { cookie: managerCookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ enabled: false, publish_scope: 'all_active' });

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/banlist-publication',
      headers: { cookie: managerCookie },
      payload: { enabled: true, publish_scope: 'all_active' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, publish_scope: 'all_active' });

    await assertAuditRow(h, {
      action: 'settings.banlist_publication.update',
      resource: 'banlist_publication_settings',
      targetId: '1',
    });
  });
});

describeIfDb('GET /api/v1/public/banlist auth', () => {
  it('401 without any Authorization header', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/public/banlist' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
  });

  it('403 for a token minted without the banlist:read scope', async () => {
    const plaintext = await mintToken(ownerCookie, []);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('404 when publication is disabled even with a valid scoped token', async () => {
    await setPublicationSettings(managerCookie, { enabled: false, publish_scope: 'all_active' });
    const plaintext = await mintToken(ownerCookie, ['banlist:read']);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('banlist_publication_disabled');
  });
});

describeIfDb('GET /api/v1/public/banlist payload', () => {
  let token: string;

  beforeAll(async () => {
    await setPublicationSettings(managerCookie, { enabled: true, publish_scope: 'all_active' });

    const permPlayerId = await seedBanTarget(PERM_STEAM, null);
    const futurePlayerId = await seedBanTarget(FUTURE_STEAM, null);
    const expiredPlayerId = await seedBanTarget(EXPIRED_STEAM, null);
    const revertedPlayerId = await seedBanTarget(REVERTED_STEAM, null);
    const eosOnlyPlayerId = await seedBanTarget(null, EOS_ONLY_ID);

    await insertBan({ playerId: permPlayerId, banLength: '0', reason: 'permanent cheater' });
    await insertBan({ playerId: futurePlayerId, banLength: '7d', reason: 'future temp ban' });
    await insertBan({
      playerId: expiredPlayerId,
      banLength: '1s',
      reason: 'already expired',
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertBan({
      playerId: revertedPlayerId,
      banLength: '0',
      reason: 'unbanned',
      revertedAt: new Date(),
    });
    await insertBan({ playerId: eosOnlyPlayerId, banLength: '0', reason: 'eos-only cheater' });

    token = await mintToken(ownerCookie, ['banlist:read']);
  });

  it('squad_cfg contains exactly the permanent + future-temp bans, matching the CBAN-2 grammar', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const lines = res.body.split('\n').filter((line) => line.length > 0);
    for (const line of lines) {
      expect(line).toMatch(/^Banned:\d{17}:(0|\d+)( \/\/ .*)?$/);
    }

    const bySteamId = new Map<string, RegExpMatchArray['groups']>();
    for (const line of lines) {
      const match = SQUAD_BANS_CFG_LINE_PATTERN.exec(line);
      expect(match?.groups).toBeTruthy();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      bySteamId.set(match!.groups!.steamId as string, match!.groups);
    }

    expect(bySteamId.has(String(PERM_STEAM))).toBe(true);
    expect(bySteamId.get(String(PERM_STEAM))?.expiry).toBe('0');
    expect(bySteamId.has(String(FUTURE_STEAM))).toBe(true);
    expect(Number(bySteamId.get(String(FUTURE_STEAM))?.expiry)).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(bySteamId.has(String(EXPIRED_STEAM))).toBe(false);
    expect(bySteamId.has(String(REVERTED_STEAM))).toBe(false);
    // eos-only bans have no steam_id64 and cannot appear in squad_cfg output.
    expect(lines.some((line) => line.includes('eos-only'))).toBe(false);
  });

  it('json includes eos_id/nickname/reason/issued_at/expires_at/admin and never IP/notes', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generated_at: string;
      bans: Array<Record<string, unknown>>;
    };
    expect(body.generated_at).toBeTruthy();

    const bySteam = new Map(body.bans.map((b) => [b.steam_id64, b]));
    expect(bySteam.has(String(PERM_STEAM))).toBe(true);
    expect(bySteam.has(String(FUTURE_STEAM))).toBe(true);
    expect(bySteam.has(String(EXPIRED_STEAM))).toBe(false);
    expect(bySteam.has(String(REVERTED_STEAM))).toBe(false);

    const eosEntry = body.bans.find((b) => b.eos_id === EOS_ONLY_ID);
    expect(eosEntry).toBeTruthy();
    expect(eosEntry?.steam_id64).toBeNull();

    for (const entry of body.bans) {
      expect(entry).toHaveProperty('steam_id64');
      expect(entry).toHaveProperty('eos_id');
      expect(entry).toHaveProperty('nickname');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('issued_at');
      expect(entry).toHaveProperty('expires_at');
      expect(entry).toHaveProperty('admin');
    }

    const raw = JSON.stringify(body);
    expect(raw.toLowerCase()).not.toContain('"ip"');
    expect(raw.toLowerCase()).not.toContain('last_known_ip');
    expect(raw.toLowerCase()).not.toContain('note');
  });

  it('permanent_only scope drops the temporary ban from both formats', async () => {
    await setPublicationSettings(managerCookie, {
      enabled: true,
      publish_scope: 'permanent_only',
    });

    const cfgRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cfgRes.body).toContain(String(PERM_STEAM));
    expect(cfgRes.body).not.toContain(String(FUTURE_STEAM));

    const jsonRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${token}` },
    });
    const jsonBody = jsonRes.json() as { bans: Array<{ steam_id64: string | null }> };
    expect(jsonBody.bans.some((b) => b.steam_id64 === String(FUTURE_STEAM))).toBe(false);
    expect(jsonBody.bans.some((b) => b.steam_id64 === String(PERM_STEAM))).toBe(true);

    // restore scope for subsequent tests in this file
    await setPublicationSettings(managerCookie, { enabled: true, publish_scope: 'all_active' });
  });

  it('unbanning (reverted_at set) removes the entry from the output', async () => {
    const before = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${token}` },
    });
    const beforeBody = before.json() as { bans: Array<{ steam_id64: string | null }> };
    expect(beforeBody.bans.some((b) => b.steam_id64 === String(PERM_STEAM))).toBe(true);

    await h.db
      .update(moderationActions)
      .set({ revertedAt: new Date() })
      .where(eq(moderationActions.playerId, await bySteamIdPlayerId(PERM_STEAM)));

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${token}` },
    });
    const afterBody = after.json() as { bans: Array<{ steam_id64: string | null }> };
    expect(afterBody.bans.some((b) => b.steam_id64 === String(PERM_STEAM))).toBe(false);
  });

  it('ETag: a repeated GET with If-None-Match returns 304', async () => {
    const first = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });

  it('revoking the token causes the next request to 401', async () => {
    const revocable = await mintTokenWithId(ownerCookie, ['banlist:read']);
    const check = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${revocable.plaintext}` },
    });
    expect(check.statusCode).toBe(200);

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${revocable.id}`,
      headers: { cookie: ownerCookie },
    });

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { authorization: `Bearer ${revocable.plaintext}` },
    });
    expect(after.statusCode).toBe(401);
  });

  async function bySteamIdPlayerId(steamId64: bigint): Promise<string> {
    const [row] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    // biome-ignore lint/style/noNonNullAssertion: seeded above
    return row!.id;
  }

  async function mintTokenWithId(
    cookie: string,
    scopes: string[],
  ): Promise<{ id: string; plaintext: string }> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: `revocable-${Date.now()}`, scopes },
    });
    return res.json() as { id: string; plaintext: string };
  }
});

describeIfDb('missing/invalid context.ban_length is treated as permanent', () => {
  it('a ban row with no ban_length in context still publishes as permanent', async () => {
    await setPublicationSettings(managerCookie, { enabled: true, publish_scope: 'all_active' });
    const noLengthSteam = testSteamId(110020);
    const playerId = await seedBanTarget(noLengthSteam, null);
    await h.db.insert(moderationActions).values({
      playerId,
      actionType: 'ban',
      authorSystemLabel: 'test-harness',
      reason: 'legacy row without ban_length',
      context: {},
    });

    const token = await mintToken(ownerCookie, ['banlist:read']);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`Banned:${noLengthSteam}:0`);
  });
});

describeIfDb('non-ban moderation_actions are never published', () => {
  it('a warn action for the same player does not leak into the banlist', async () => {
    await setPublicationSettings(managerCookie, { enabled: true, publish_scope: 'all_active' });
    const warnSteam = testSteamId(110021);
    const playerId = await seedBanTarget(warnSteam, null);
    await h.db.insert(moderationActions).values({
      playerId,
      actionType: 'warn',
      authorSystemLabel: 'test-harness',
      reason: 'just a warning',
      context: {},
    });

    const token = await mintToken(ownerCookie, ['banlist:read']);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=squad_cfg',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.body).not.toContain(String(warnSteam));
  });
});
