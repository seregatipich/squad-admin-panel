import { players } from '@squad/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const OWNER_STEAM = testSteamId(975001);
const PLAYER_STEAM = testSteamId(975002);
const FRIEND_STEAM = testSteamId(975003);
const EOS_ONLY_STEAM = null;

let h: IntegrationHarness;
let playerId: string;
let friendId: string;
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

describeIfDb('GET /api/v1/players/:id/steam-friend-check', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
    playerId = await seedPlayer(PLAYER_STEAM, 'Steam player');
    friendId = await seedPlayer(FRIEND_STEAM, 'Steam friend');
    eosOnlyId = await seedPlayer(EOS_ONLY_STEAM, 'EOS only');
  });

  beforeEach(async () => {
    h.app.config.STEAM_API_KEY = undefined;
    vi.unstubAllGlobals();
    await h.redis.del(`steam-friend-check:${PLAYER_STEAM}:${FRIEND_STEAM}`);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    invalidateAllPermissionCaches();
    await h.cleanup();
  });

  it('requires panel access', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/steam-friend-check?other=${friendId}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns a graceful no_steam_id state for EOS-only accounts', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${eosOnlyId}/steam-friend-check?other=${friendId}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      in_friend: null,
      reason: 'no_steam_id',
      cached: false,
    });
  });

  it('checks Steam once and serves the second request from the 24-hour cache', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          friendslist: { friends: [{ steamid: String(FRIEND_STEAM) }] },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const cookie = await loginAsOwner(h);
    const url = `/api/v1/players/${playerId}/steam-friend-check?other=${friendId}`;

    const first = await h.app.inject({ method: 'GET', url, headers: { cookie } });
    const second = await h.app.inject({ method: 'GET', url, headers: { cookie } });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ in_friend: true, reason: null, cached: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ in_friend: true, reason: null, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const steamRequest = String(fetchMock.mock.calls[0]?.[0]);
    expect(steamRequest).toContain('ISteamUser/GetFriendList');
    expect(steamRequest).toContain('relationship=friend');
    expect(steamRequest).toContain(`steamid=${PLAYER_STEAM}`);
  });

  it('returns private_profile when Steam does not expose the friends list', async () => {
    h.app.config.STEAM_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/steam-friend-check?other=${friendId}`,
      headers: { cookie: await loginAsOwner(h) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      in_friend: null,
      reason: 'private_profile',
      cached: false,
    });
  });

  it('reports Steam API not configured without making an external request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/steam-friend-check?other=${friendId}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      in_friend: null,
      reason: 'api_key_missing',
      cached: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
