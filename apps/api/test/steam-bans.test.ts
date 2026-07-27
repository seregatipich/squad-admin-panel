import { describe, expect, it, vi } from 'vitest';
import { fetchSteamBans, STEAM_BANS_BATCH_SIZE } from '../src/lib/steam-bans.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
      store.set(k, v);
      return 'OK' as const;
    }),
    _store: store,
  };
};

function banPayload(overrides: Record<string, unknown> = {}) {
  return {
    SteamId: '76561198000000001',
    CommunityBanned: false,
    VACBanned: true,
    NumberOfVACBans: 2,
    DaysSinceLastBan: 412,
    NumberOfGameBans: 1,
    EconomyBan: 'none',
    ...overrides,
  };
}

describe('fetchSteamBans', () => {
  it('returns null when API key is empty without calling Steam', async () => {
    const fetchMock = vi.fn();
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: '',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses the PascalCase GetPlayerBans payload and caches every entry', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ players: [banPayload()] }),
    });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.get('76561198000000001')).toEqual({
      steamId64: '76561198000000001',
      communityBanned: false,
      vacBanned: true,
      vacBanCount: 2,
      gameBanCount: 1,
      daysSinceLastBan: 412,
      economyBan: 'none',
    });
    expect(redis._store.has('steam-bans:76561198000000001')).toBe(true);
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/');
    expect(requested).toContain('steamids=76561198000000001');
  });

  it('treats a non-boolean VACBanned and a missing DaysSinceLastBan defensively', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        players: [
          banPayload({
            VACBanned: undefined,
            NumberOfVACBans: undefined,
            NumberOfGameBans: undefined,
            DaysSinceLastBan: undefined,
            EconomyBan: undefined,
          }),
        ],
      }),
    });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.get('76561198000000001')).toEqual({
      steamId64: '76561198000000001',
      communityBanned: false,
      vacBanned: false,
      vacBanCount: 0,
      gameBanCount: 0,
      daysSinceLastBan: null,
      economyBan: null,
    });
  });

  it('keeps EconomyBan as the string Steam returns rather than coercing it', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ players: [banPayload({ EconomyBan: 'banned' })] }),
    });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.get('76561198000000001')?.economyBan).toBe('banned');
  });

  it('serves cached ids without a request and only fetches the missing ones', async () => {
    const redis = fakeRedis();
    redis._store.set(
      'steam-bans:76561198000000001',
      JSON.stringify({
        steamId64: '76561198000000001',
        communityBanned: false,
        vacBanned: false,
        vacBanCount: 0,
        gameBanCount: 0,
        daysSinceLastBan: null,
        economyBan: 'none',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ players: [banPayload({ SteamId: '76561198000000002' })] }),
    });
    const res = await fetchSteamBans([76561198000000001n, 76561198000000002n], {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.size).toBe(2);
    expect(res?.get('76561198000000001')?.vacBanned).toBe(false);
    expect(res?.get('76561198000000002')?.vacBanned).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('76561198000000001');
  });

  it('refetches an id whose cached entry is corrupt JSON', async () => {
    const redis = fakeRedis();
    redis._store.set('steam-bans:76561198000000001', '{not-json');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ players: [banPayload()] }),
    });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.get('76561198000000001')?.vacBanCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('splits more ids than the batch size across several requests', async () => {
    const redis = fakeRedis();
    const ids = Array.from(
      { length: STEAM_BANS_BATCH_SIZE + 1 },
      (_, i) => 76561198000000001n + BigInt(i),
    );
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const requested = (url.searchParams.get('steamids') ?? '').split(',');
      return {
        ok: true,
        json: async () => ({ players: requested.map((id) => banPayload({ SteamId: id })) }),
      };
    });
    const res = await fetchSteamBans(ids, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('steamids')?.split(','),
    ).toHaveLength(STEAM_BANS_BATCH_SIZE);
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('steamids')?.split(','),
    ).toHaveLength(1);
    expect(res?.size).toBe(STEAM_BANS_BATCH_SIZE + 1);
  });

  it('returns null when Steam answers non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
  });

  it('omits ids Steam did not answer for instead of inventing rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const res = await fetchSteamBans([76561198000000001n], {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.size).toBe(0);
  });

  it('returns an empty map for an empty id list without calling Steam', async () => {
    const fetchMock = vi.fn();
    const res = await fetchSteamBans([], {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
