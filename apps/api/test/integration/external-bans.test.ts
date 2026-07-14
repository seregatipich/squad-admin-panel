import { externalBanSources, externalBans, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(942001);
const NO_ACCESS_STEAM = testSteamId(942002);

const STEAM_TWO_SOURCES = testSteamId(942010).toString();
const EOS_ONLY = 'eos-cban3-test-001';
const STEAM_HISTORY = testSteamId(942011).toString();
const STEAM_ZERO = testSteamId(942012).toString();
const STEAM_OR_MATCH = testSteamId(942013).toString();
const EOS_OR_MATCH = 'eos-cban3-test-002';

let h: IntegrationHarness;
let ownerCookie: string;
let noAccessCookie: string;

let sourceTrustedId: string;
let sourceNormalId: string;

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(opts: {
  steamId64: bigint | null;
  eosId: string | null;
  namePrefix: string;
  panelAccess: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `Role-${opts.namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
  });
  const id = uuidv7();
  const stub = `${opts.namePrefix}${Date.now()}`;
  await h.db.insert(players).values({
    id,
    steamId64: opts.steamId64,
    eosId: opts.eosId,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
  return id;
}

async function createSourceRow(name: string, trustLevel: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(externalBanSources).values({
    id,
    name,
    url: `https://collabans.example.com/${name}.cfg`,
    format: 'squad_bans_cfg',
    trustLevel,
    discordUrl: 'https://discord.gg/example',
  });
  return id;
}

async function createBanRow(
  overrides: Partial<typeof externalBans.$inferInsert> & { sourceId: string },
): Promise<void> {
  await h.db.insert(externalBans).values({
    steamId64: null,
    eosId: null,
    nickname: 'TestCheater',
    reason: 'aimbot',
    adminName: 'ExternalAdmin',
    issuedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  });
}

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  await seedPlayer({
    steamId64: NO_ACCESS_STEAM,
    eosId: null,
    namePrefix: 'NoAccess',
    panelAccess: false,
  });

  sourceTrustedId = await createSourceRow(`CBAN3-Trusted-${Date.now()}`, 'trusted');
  sourceNormalId = await createSourceRow(`CBAN3-Normal-${Date.now()}`, 'normal');

  // Player present in two sources, one active ban each.
  await seedPlayer({
    steamId64: BigInt(STEAM_TWO_SOURCES),
    eosId: null,
    namePrefix: 'TwoSources',
    panelAccess: true,
  });
  await createBanRow({
    sourceId: sourceTrustedId,
    steamId64: STEAM_TWO_SOURCES,
    nickname: 'TwoSourcesNick',
    reason: 'cheating',
  });
  await createBanRow({
    sourceId: sourceNormalId,
    steamId64: STEAM_TWO_SOURCES,
    nickname: 'TwoSourcesNick',
    reason: 'toxicity',
  });

  // EOS-only player, matched by eos_id.
  await seedPlayer({ steamId64: null, eosId: EOS_ONLY, namePrefix: 'EosOnly', panelAccess: true });
  await createBanRow({ sourceId: sourceTrustedId, eosId: EOS_ONLY, nickname: 'EosOnlyNick' });

  // Player with an expired ban and a revoked ban — both must appear in
  // history but neither should count toward active_source_count.
  await seedPlayer({
    steamId64: BigInt(STEAM_HISTORY),
    eosId: null,
    namePrefix: 'History',
    panelAccess: true,
  });
  await createBanRow({
    sourceId: sourceTrustedId,
    steamId64: STEAM_HISTORY,
    nickname: 'ExpiredNick',
    expiresAt: new Date('2020-01-01T00:00:00Z'),
  });
  await createBanRow({
    sourceId: sourceNormalId,
    steamId64: STEAM_HISTORY,
    nickname: 'RevokedNick',
    revokedAt: new Date('2026-01-05T00:00:00Z'),
  });

  // Player with zero external bans.
  await seedPlayer({
    steamId64: BigInt(STEAM_ZERO),
    eosId: null,
    namePrefix: 'ZeroBans',
    panelAccess: true,
  });

  // Player whose steamId64 matches source A and eosId matches source B (OR-match, no dup).
  await seedPlayer({
    steamId64: BigInt(STEAM_OR_MATCH),
    eosId: EOS_OR_MATCH,
    namePrefix: 'OrMatch',
    panelAccess: true,
  });
  await createBanRow({
    sourceId: sourceTrustedId,
    steamId64: STEAM_OR_MATCH,
    nickname: 'OrMatchBySteam',
  });
  await createBanRow({ sourceId: sourceNormalId, eosId: EOS_OR_MATCH, nickname: 'OrMatchByEos' });

  // Three distinct identities sharing a unique nickname tag, isolated from
  // any data other test files may insert into the shared external_bans
  // table, for a deterministic pagination assertion (total === 3).
  for (let i = 0; i < 3; i++) {
    await createBanRow({
      sourceId: sourceTrustedId,
      steamId64: testSteamId(942060 + i).toString(),
      nickname: 'Cban3PagingNick',
    });
  }

  ownerCookie = await loginAsOwner(h);
  noAccessCookie = await loginAsSteam(NO_ACCESS_STEAM, 'external-bans-no-access');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

async function getPlayerId(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`player missing for ${steamId64}`);
  return row.id;
}

describeIfDb('GET /api/v1/players/:playerId/external-bans', () => {
  it('returns 401 unauthenticated', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_TWO_SOURCES));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
  });

  it('returns 403 for a session without panel_access', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_TWO_SOURCES));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
      headers: { cookie: noAccessCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('returns 404 for an unknown playerId', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/00000000-0000-0000-0000-000000000000/external-bans',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('player_not_found');
  });

  it('aggregates a player present in two sources with correct trust levels and active_source_count', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_TWO_SOURCES));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(2);
    expect(body.active_source_count).toBe(2);
    expect(body.total).toBe(2);
    const trustLevels = body.sources.map(
      (s: { source: { trust_level: string } }) => s.source.trust_level,
    );
    expect(trustLevels.sort()).toEqual(['normal', 'trusted']);
    for (const source of body.sources) {
      expect(source.bans).toHaveLength(1);
      expect(source.active_count).toBe(1);
      expect(source.bans[0].is_active).toBe(true);
    }
  });

  it('matches an EOS-only player by eos_id', async () => {
    const [row] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.eosId, EOS_ONLY))
      .limit(1);
    if (!row) throw new Error('EOS-only player missing');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${row.id}/external-bans`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.active_source_count).toBe(1);
    expect(body.sources[0].bans[0].nickname).toBe('EosOnlyNick');
  });

  it('excludes expired and revoked bans from active_source_count but keeps them in history', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_HISTORY));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(2);
    expect(body.active_source_count).toBe(0);
    expect(body.total).toBe(2);
    const allBans = body.sources.flatMap(
      (s: { bans: Array<{ is_active: boolean; nickname: string }> }) => s.bans,
    );
    const expired = allBans.find((b: { nickname: string }) => b.nickname === 'ExpiredNick');
    const revoked = allBans.find((b: { nickname: string }) => b.nickname === 'RevokedNick');
    expect(expired.is_active).toBe(false);
    expect(revoked.is_active).toBe(false);
  });

  it('returns empty aggregate for a player with zero external bans', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_ZERO));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: [], active_source_count: 0, total: 0 });
  });

  it('OR-matches steam_id64 in one source and eos_id in another with no duplicates', async () => {
    const playerId = await getPlayerId(BigInt(STEAM_OR_MATCH));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/external-bans`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(2);
    expect(body.total).toBe(2);
    const nicknames = body.sources
      .flatMap((s: { bans: Array<{ nickname: string }> }) => s.bans)
      .map((b: { nickname: string }) => b.nickname);
    expect(nicknames.sort()).toEqual(['OrMatchByEos', 'OrMatchBySteam']);
  });
});

describeIfDb('GET /api/v1/external-bans (registry)', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/external-bans' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a session without panel_access', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/external-bans',
      headers: { cookie: noAccessCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('searches by nickname substring', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/external-bans?q=TwoSourcesNick',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    expect(body.rows.some((r: { steam_id64: string }) => r.steam_id64 === STEAM_TWO_SOURCES)).toBe(
      true,
    );
  });

  it('searches by exact steam_id64', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${STEAM_TWO_SOURCES}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.some((r: { steam_id64: string }) => r.steam_id64 === STEAM_TWO_SOURCES)).toBe(
      true,
    );
  });

  it('searches by exact eos_id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${EOS_ONLY}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.some((r: { eos_id: string }) => r.eos_id === EOS_ONLY)).toBe(true);
  });

  it('searches by reason substring', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/external-bans?q=toxicity',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.some((r: { steam_id64: string }) => r.steam_id64 === STEAM_TWO_SOURCES)).toBe(
      true,
    );
  });

  it('permanent_only=true returns only rows whose bans are all expires_at IS NULL', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${STEAM_HISTORY}&permanent_only=true`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The expired ban (has expires_at) is filtered out; only the revoked
    // permanent ban (expires_at IS NULL) remains, still grouped under the
    // player's identity.
    const row = body.rows.find((r: { steam_id64: string }) => r.steam_id64 === STEAM_HISTORY);
    expect(row).toBeDefined();
    expect(row.bans.every((b: { expires_at: string | null }) => b.expires_at === null)).toBe(true);
  });

  it('source_id filter returns only that source identities', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${STEAM_TWO_SOURCES}&source_id=${sourceTrustedId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.rows.find((r: { steam_id64: string }) => r.steam_id64 === STEAM_TWO_SOURCES);
    expect(row).toBeDefined();
    expect(row.bans.every((b: { source_id: string }) => b.source_id === sourceTrustedId)).toBe(
      true,
    );
  });

  it('paginates: 3 seeded identities, limit=2 offset=0 → 2 rows total=3; offset=2 → 1 row', async () => {
    const page1 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/external-bans?q=Cban3PagingNick&limit=2&offset=0',
      headers: { cookie: ownerCookie },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.rows).toHaveLength(2);
    expect(body1.total).toBe(3);
    expect(body1.limit).toBe(2);
    expect(body1.offset).toBe(0);

    const page2 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/external-bans?q=Cban3PagingNick&limit=2&offset=2',
      headers: { cookie: ownerCookie },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.rows).toHaveLength(1);
    expect(body2.total).toBe(3);
  });

  it('attaches player_id/panel_nickname when the identity is known to the panel, null otherwise', async () => {
    const known = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${STEAM_TWO_SOURCES}`,
      headers: { cookie: ownerCookie },
    });
    const knownRow = known.json().rows[0];
    expect(knownRow.player_id).not.toBeNull();
    expect(knownRow.panel_nickname).not.toBeNull();

    const unknownSteam = testSteamId(942099).toString();
    const otherSourceId = await createSourceRow(`CBAN3-Unknown-${Date.now()}`, 'low');
    await createBanRow({
      sourceId: otherSourceId,
      steamId64: unknownSteam,
      nickname: 'UnknownIdentity',
    });
    const unknown = await h.app.inject({
      method: 'GET',
      url: `/api/v1/external-bans?q=${unknownSteam}`,
      headers: { cookie: ownerCookie },
    });
    const unknownRow = unknown.json().rows[0];
    expect(unknownRow.player_id).toBeNull();
    expect(unknownRow.panel_nickname).toBeNull();
  });
});
