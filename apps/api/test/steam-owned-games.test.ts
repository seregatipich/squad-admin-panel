import { describe, expect, it, vi } from 'vitest';
import { fetchSteamOwnedGames, SQUAD_APP_ID } from '../src/lib/steam-owned-games.js';

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

describe('fetchSteamOwnedGames', () => {
  it('returns null when API key is empty without calling Steam', async () => {
    const fetchMock = vi.fn();
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: '',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports ownership and playtime when Squad is in the filtered game list', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: { game_count: 1, games: [{ appid: SQUAD_APP_ID, playtime_forever: 4321 }] },
      }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: true, playtimeMinutes: 4321 });
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
    expect(requested).toContain(`appids_filter%5B0%5D=${SQUAD_APP_ID}`);
    expect(requested).toContain('steamid=76561198000000001');
    expect(redis._store.has('steam-owned-games:76561198000000001')).toBe(true);
  });

  it('reports no ownership when the filtered game list comes back empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { game_count: 0, games: [] } }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: false, playtimeMinutes: null });
  });

  it('reports unknown ownership when the response carries no games key at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: {} }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: null, playtimeMinutes: null });
  });

  it('reports no ownership when the list holds only other games', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { games: [{ appid: 730, playtime_forever: 10 }] } }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: false, playtimeMinutes: null });
  });

  it('leaves playtime unknown when Squad is owned but the field is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { games: [{ appid: SQUAD_APP_ID }] } }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: true, playtimeMinutes: null });
  });

  it('serves a repeat call from the 24-hour cache', async () => {
    const redis = fakeRedis();
    redis._store.set(
      'steam-owned-games:76561198000000001',
      JSON.stringify({ ownsSquad: true, playtimeMinutes: 100 }),
    );
    const fetchMock = vi.fn();
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: true, playtimeMinutes: 100 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when the cached entry is corrupt JSON', async () => {
    const redis = fakeRedis();
    redis._store.set('steam-owned-games:76561198000000001', '{not-json');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { games: [{ appid: SQUAD_APP_ID, playtime_forever: 7 }] } }),
    });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ ownsSquad: true, playtimeMinutes: 7 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns null when Steam answers non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const res = await fetchSteamOwnedGames(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
  });
});
