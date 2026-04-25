import { describe, expect, it, vi } from 'vitest';
import { fetchSteamProfile } from '../src/lib/steam-profile.js';

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

describe('fetchSteamProfile', () => {
  it('returns null when API key is empty', async () => {
    const fetchMock = vi.fn();
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: '',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hits Steam Web API and caches the result on hit', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          players: [
            { steamid: '76561198000000001', personaname: 'TestUser', avatarfull: 'http://a' },
          ],
        },
      }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ persona: 'TestUser', avatarUrl: 'http://a' });
    expect(redis.set).toHaveBeenCalled();
    const cachedKey = 'steam-profile:76561198000000001';
    expect(redis._store.has(cachedKey)).toBe(true);
  });

  it('returns cached value on repeat call', async () => {
    const redis = fakeRedis();
    redis._store.set(
      'steam-profile:76561198000000001',
      JSON.stringify({ persona: 'Cached', avatarUrl: '' }),
    );
    const fetchMock = vi.fn();
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ persona: 'Cached', avatarUrl: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on non-200 response without throwing', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
  });

  it('returns null when Steam payload has empty players[]', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { players: [] } }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
  });

  it('refetches if cached value is corrupt JSON', async () => {
    const redis = fakeRedis();
    redis._store.set('steam-profile:76561198000000001', '{not-json');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          players: [{ steamid: '76561198000000001', personaname: 'Recovered', avatarfull: '' }],
        },
      }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res?.persona).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
