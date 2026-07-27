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
            {
              steamid: '76561198000000001',
              personaname: 'TestUser',
              avatarfull: 'http://a',
              communityvisibilitystate: 3,
              timecreated: 1_234_567_890,
            },
          ],
        },
      }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({
      persona: 'TestUser',
      avatarUrl: 'http://a',
      visibility: 3,
      createdAt: 1_234_567_890,
    });
    expect(redis.set).toHaveBeenCalled();
    const cachedKey = 'steam-profile:76561198000000001';
    expect(redis._store.has(cachedKey)).toBe(true);
  });

  it('leaves visibility and creation date null for a private profile that hides them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: { players: [{ steamid: '76561198000000001', personaname: 'Hidden' }] },
      }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ persona: 'Hidden', avatarUrl: '', visibility: null, createdAt: null });
  });

  it('returns cached value on repeat call', async () => {
    const redis = fakeRedis();
    redis._store.set(
      'steam-profile:76561198000000001',
      JSON.stringify({ persona: 'Cached', avatarUrl: '', visibility: 1, createdAt: 42 }),
    );
    const fetchMock = vi.fn();
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ persona: 'Cached', avatarUrl: '', visibility: 1, createdAt: 42 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalises a pre-INT-1 cache entry that predates the visibility fields', async () => {
    const redis = fakeRedis();
    redis._store.set(
      'steam-profile:76561198000000001',
      JSON.stringify({ persona: 'Legacy', avatarUrl: 'http://old' }),
    );
    const fetchMock = vi.fn();
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({
      persona: 'Legacy',
      avatarUrl: 'http://old',
      visibility: null,
      createdAt: null,
    });
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
