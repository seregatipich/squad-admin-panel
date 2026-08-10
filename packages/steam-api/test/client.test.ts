import { describe, expect, it, vi } from 'vitest';
import { fetchSteamProfiles, STEAM_BATCH_SIZE } from '../src/index.js';

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    store,
  };
}

describe('fetchSteamProfiles', () => {
  it('does not call Steam without an API key', async () => {
    const request = vi.fn();

    await expect(
      fetchSteamProfiles([76561198000000001n], {
        apiKey: '',
        redis: memoryRedis(),
        fetch: request as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('uses cached profiles and batches at most 100 cold ids per request', async () => {
    const redis = memoryRedis();
    const ids = Array.from(
      { length: STEAM_BATCH_SIZE + 1 },
      (_, index) => 76561198000000000n + BigInt(index + 1),
    );
    redis.store.set(
      `steam-profile:${ids[0]}`,
      JSON.stringify({
        persona: 'Cached',
        avatarUrl: '',
        visibility: 1,
        createdAt: null,
      }),
    );
    const request = vi.fn(async (url: URL) => {
      const requestedIds = url.searchParams.get('steamids')?.split(',') ?? [];
      return {
        ok: true,
        json: async () => ({
          response: {
            players: requestedIds.map((steamid) => ({
              steamid,
              personaname: `Player ${steamid.slice(-3)}`,
              avatarfull: '',
              communityvisibilitystate: 3,
            })),
          },
        }),
      };
    });

    const result = await fetchSteamProfiles(ids, {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(result?.size).toBe(ids.length);
    expect(result?.get(String(ids[0]))?.persona).toBe('Cached');
    expect(request).toHaveBeenCalledTimes(1);
    const requested = (request.mock.calls[0]?.[0] as URL).searchParams.get('steamids')?.split(',');
    expect(requested).toHaveLength(STEAM_BATCH_SIZE);
  });

  it('splits more than 100 cold ids into bounded requests', async () => {
    const redis = memoryRedis();
    const ids = Array.from(
      { length: STEAM_BATCH_SIZE + 1 },
      (_, index) => 76561198100000000n + BigInt(index),
    );
    const request = vi.fn(async (url: URL) => {
      const requestedIds = url.searchParams.get('steamids')?.split(',') ?? [];
      return {
        ok: true,
        json: async () => ({
          response: {
            players: requestedIds.map((steamid) => ({ steamid, personaname: steamid })),
          },
        }),
      };
    });

    await fetchSteamProfiles(ids, {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      (request.mock.calls[0]?.[0] as URL).searchParams.get('steamids')?.split(','),
    ).toHaveLength(STEAM_BATCH_SIZE);
    expect(
      (request.mock.calls[1]?.[0] as URL).searchParams.get('steamids')?.split(','),
    ).toHaveLength(1);
  });
});
