import { describe, expect, it, vi } from 'vitest';
import {
  fetchSteamBans,
  fetchSteamOwnedGames,
  fetchSteamProfiles,
  STEAM_BATCH_SIZE,
} from '../src/index.js';

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

  it('keeps results from a successful batch when a later batch fails (#1191)', async () => {
    const redis = memoryRedis();
    const ids = Array.from(
      { length: STEAM_BATCH_SIZE + 1 },
      (_, index) => 76561198200000000n + BigInt(index),
    );
    let call = 0;
    const request = vi.fn(async (url: URL) => {
      call++;
      const requestedIds = url.searchParams.get('steamids')?.split(',') ?? [];
      if (call === 2) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          response: { players: requestedIds.map((steamid) => ({ steamid, personaname: steamid })) },
        }),
      };
    });

    const result = await fetchSteamProfiles(ids, {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(request).toHaveBeenCalledTimes(2);
    // The first batch's results must survive the second batch's failure
    // instead of the whole call collapsing to null.
    expect(result).not.toBeNull();
    expect(result?.size).toBe(STEAM_BATCH_SIZE);
  });

  it('does not throw when a 200 response body is not valid JSON', async () => {
    const redis = memoryRedis();
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));

    await expect(
      fetchSteamProfiles([76561198000000099n], {
        apiKey: 'test-key',
        redis,
        fetch: request as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });
});

describe('fetchSteamBans cache validation (#1189)', () => {
  it('treats a malformed cached ban entry as cold and re-fetches it', async () => {
    const redis = memoryRedis();
    const id = '76561198000000123';
    redis.store.set(`steam-bans:${id}`, JSON.stringify({ unexpected: 'shape' }));
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        players: [
          {
            SteamId: id,
            CommunityBanned: false,
            VACBanned: true,
            NumberOfVACBans: 2,
            NumberOfGameBans: 0,
            DaysSinceLastBan: 10,
          },
        ],
      }),
    }));

    const result = await fetchSteamBans([BigInt(id)], {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result?.get(id)?.vacBanCount).toBe(2);
  });

  it('uses a well-formed cached ban entry without calling Steam', async () => {
    const redis = memoryRedis();
    const id = '76561198000000124';
    redis.store.set(
      `steam-bans:${id}`,
      JSON.stringify({
        steamId64: id,
        communityBanned: false,
        vacBanned: false,
        vacBanCount: 0,
        gameBanCount: 0,
        daysSinceLastBan: null,
        economyBan: null,
      }),
    );
    const request = vi.fn();

    const result = await fetchSteamBans([BigInt(id)], {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(request).not.toHaveBeenCalled();
    expect(result?.get(id)?.steamId64).toBe(id);
  });
});

describe('fetchSteamOwnedGames cache validation (#1189)', () => {
  it('treats a malformed cached owned-games entry as cold and re-fetches it', async () => {
    const redis = memoryRedis();
    const id = 76561198000000200n;
    redis.store.set(`steam-owned-games:${id}`, JSON.stringify({ unexpected: 'shape' }));
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: { games: [{ appid: 393380, playtime_forever: 42 }] } }),
    }));

    const result = await fetchSteamOwnedGames(id, {
      apiKey: 'test-key',
      redis,
      fetch: request as unknown as typeof fetch,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result?.playtimeMinutes).toBe(42);
  });
});

// #53 (#1188): a hung api.steampowered.com used to hold Steam login (and the
// steam-refresh tick) for undici's 300 s default.
describe('Steam request deadline', () => {
  /** A fetch that never answers on its own — it settles only when aborted. */
  function hangingFetch() {
    return vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  }

  const calls = [
    [
      'fetchSteamProfiles',
      (deps: Parameters<typeof fetchSteamProfiles>[1]) =>
        fetchSteamProfiles([76561198000000001n], deps),
    ],
    [
      'fetchSteamBans',
      (deps: Parameters<typeof fetchSteamBans>[1]) => fetchSteamBans([76561198000000001n], deps),
    ],
    [
      'fetchSteamOwnedGames',
      (deps: Parameters<typeof fetchSteamOwnedGames>[1]) =>
        fetchSteamOwnedGames(76561198000000001n, deps),
    ],
  ] as const;

  it.each(calls)('%s aborts a hung request after timeoutMs', async (_name, call) => {
    const request = hangingFetch();
    const started = Date.now();
    await expect(
      call({
        apiKey: 'key',
        redis: memoryRedis(),
        fetch: request as unknown as typeof fetch,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each(calls)('%s always sends an abort signal (default deadline)', async (_name, call) => {
    const request = vi.fn(async (_url: URL, _init?: RequestInit) => ({
      ok: false,
      json: async () => ({}),
    }));
    await call({ apiKey: 'key', redis: memoryRedis(), fetch: request as unknown as typeof fetch });
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
