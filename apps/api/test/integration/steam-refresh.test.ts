import { auditLog, players } from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { SQUAD_APP_ID } from '../../src/lib/steam-owned-games.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(981001);
const PLAYER_STEAM = testSteamId(981002);
const EOS_ONLY_STEAM = null;

let h: IntegrationHarness;
let playerId: string;
let eosOnlyId: string;

async function seedPlayer(steamId64: bigint | null, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

/** Routes one stubbed `fetch` across the three Steam endpoints the refresh uses. */
function stubSteam(options: {
  summaries?: unknown;
  bans?: unknown;
  ownedGames?: unknown;
  failOn?: 'summaries' | 'bans' | 'ownedGames';
}) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const which: 'summaries' | 'bans' | 'ownedGames' = url.includes('GetPlayerSummaries')
      ? 'summaries'
      : url.includes('GetPlayerBans')
        ? 'bans'
        : 'ownedGames';
    if (options.failOn === which) return new Response('rate limited', { status: 429 });
    const body =
      which === 'summaries'
        ? (options.summaries ?? {
            response: {
              players: [
                {
                  steamid: String(PLAYER_STEAM),
                  personaname: 'Стим Ник',
                  avatarfull: 'https://avatars.steamstatic.com/full.jpg',
                  communityvisibilitystate: 3,
                  timecreated: 1_300_000_000,
                },
              ],
            },
          })
        : which === 'bans'
          ? (options.bans ?? {
              players: [
                {
                  SteamId: String(PLAYER_STEAM),
                  CommunityBanned: false,
                  VACBanned: true,
                  NumberOfVACBans: 2,
                  DaysSinceLastBan: 512,
                  NumberOfGameBans: 1,
                  EconomyBan: 'none',
                },
              ],
            })
          : (options.ownedGames ?? {
              response: { games: [{ appid: SQUAD_APP_ID, playtime_forever: 9876 }] },
            });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describeIfDb('POST /api/v1/players/:playerId/steam-refresh', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
    playerId = await seedPlayer(PLAYER_STEAM, 'Steam player');
    eosOnlyId = await seedPlayer(EOS_ONLY_STEAM, 'EOS only');
  });

  beforeEach(async () => {
    h.app.config.STEAM_API_KEY = undefined;
    vi.unstubAllGlobals();
    await h.redis.del(
      `steam-profile:${PLAYER_STEAM}`,
      `steam-bans:${PLAYER_STEAM}`,
      `steam-owned-games:${PLAYER_STEAM}`,
    );
    await h.db
      .update(players)
      .set({
        avatarUrl: null,
        personaName: null,
        profileVisibility: null,
        steamAccountCreatedAt: null,
        vacBanned: false,
        vacBanCount: 0,
        gameBanCount: 0,
        daysSinceLastBan: null,
        ownsSquad: null,
        steamPlaytimeMinutes: null,
        steamCheckedAt: null,
      })
      .where(eq(players.steamId64, PLAYER_STEAM));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    invalidateAllPermissionCaches();
    await h.cleanup();
  });

  it('rejects an unauthenticated refresh', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for a player that does not exist', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/players/00000000-0000-0000-0000-0000000000ff/steam-refresh',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'player_not_found' });
  });

  it('returns 409 for a player that has no SteamID64', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    const fetchMock = stubSteam({});
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${eosOnlyId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'no_steam_id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 without an API key and never touches Steam', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'steam_api_key_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 and writes nothing when Steam answers non-OK', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    stubSteam({ failOn: 'bans' });
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: 'steam_api_error' });

    const [row] = await h.db
      .select({ checkedAt: players.steamCheckedAt, personaName: players.personaName })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM));
    expect(row.checkedAt).toBeNull();
    expect(row.personaName).toBeNull();
  });

  it('persists the full Steam snapshot, returns it, and writes an audit row', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    const fetchMock = stubSteam({});
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      avatar_url: 'https://avatars.steamstatic.com/full.jpg',
      persona_name: 'Стим Ник',
      profile_visibility: 3,
      vac_banned: true,
      vac_ban_count: 2,
      game_ban_count: 1,
      days_since_last_ban: 512,
      owns_squad: true,
      steam_playtime_minutes: 9876,
    });
    expect(typeof body.steam_checked_at).toBe('string');
    expect(new Date(body.steam_account_created_at as string).toISOString()).toBe(
      new Date(1_300_000_000 * 1000).toISOString(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [row] = await h.db.select().from(players).where(eq(players.steamId64, PLAYER_STEAM));
    expect(row.avatarUrl).toBe('https://avatars.steamstatic.com/full.jpg');
    expect(row.personaName).toBe('Стим Ник');
    expect(row.profileVisibility).toBe(3);
    expect(row.vacBanned).toBe(true);
    expect(row.vacBanCount).toBe(2);
    expect(row.gameBanCount).toBe(1);
    expect(row.daysSinceLastBan).toBe(512);
    expect(row.ownsSquad).toBe(true);
    expect(row.steamPlaytimeMinutes).toBe(9876);
    expect(row.steamCheckedAt).toBeInstanceOf(Date);
    expect(row.steamAccountCreatedAt?.getTime()).toBe(1_300_000_000 * 1000);

    const [audit] = await h.db
      .select({ actionType: auditLog.actionType, targetId: auditLog.targetId })
      .from(auditLog)
      .where(and(eq(auditLog.actionType, 'player.steam_refresh'), eq(auditLog.targetId, playerId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit).toMatchObject({ actionType: 'player.steam_refresh', targetId: playerId });
  });

  it('records unknown ownership when the Steam profile hides the game list', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    stubSteam({ ownedGames: { response: {} } });
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owns_squad: null, steam_playtime_minutes: null });
  });

  it('clears stale ban counters when Steam no longer reports the player', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    await h.db
      .update(players)
      .set({ vacBanned: true, vacBanCount: 3, gameBanCount: 2, daysSinceLastBan: 5 })
      .where(eq(players.steamId64, PLAYER_STEAM));
    stubSteam({ bans: { players: [] } });

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vac_banned: false,
      vac_ban_count: 0,
      game_ban_count: 0,
      days_since_last_ban: null,
    });
  });

  it('exposes the persisted Steam snapshot through GET /api/v1/players/:playerId', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    stubSteam({});
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/steam-refresh`,
      headers: { cookie },
    });

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const player = (detail.json() as { player: Record<string, unknown> }).player;
    expect(player).toMatchObject({
      avatar_url: 'https://avatars.steamstatic.com/full.jpg',
      persona_name: 'Стим Ник',
      profile_visibility: 3,
      vac_banned: true,
      vac_ban_count: 2,
      game_ban_count: 1,
      days_since_last_ban: 512,
      owns_squad: true,
      steam_playtime_minutes: 9876,
    });
    expect(typeof player.steam_checked_at).toBe('string');
  });

  it('serves a player that was never checked with null Steam fields', async () => {
    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${eosOnlyId}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(detail.statusCode).toBe(200);
    const player = (detail.json() as { player: Record<string, unknown> }).player;
    expect(player).toMatchObject({
      avatar_url: null,
      persona_name: null,
      profile_visibility: null,
      steam_account_created_at: null,
      vac_banned: false,
      vac_ban_count: 0,
      game_ban_count: 0,
      days_since_last_ban: null,
      owns_squad: null,
      steam_playtime_minutes: null,
      steam_checked_at: null,
    });
  });
});
