import { describe, expect, it, vi } from 'vitest';
import { fetchSteamFriendCheck } from '../src/lib/steam-friends.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    store,
  };
}

describe('fetchSteamFriendCheck', () => {
  it('returns a graceful api_key_missing state without making a request', async () => {
    const fetchMock = vi.fn();
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: '',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: null, reason: 'api_key_missing', cached: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finds a friend and caches the pair for 24 hours', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        friendslist: { friends: [{ steamid: '76561198000000002' }] },
      }),
    });
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: true, reason: null, cached: false });
    expect(redis.set).toHaveBeenCalledWith(
      'steam-friend-check:76561198000000001:76561198000000002',
      expect.any(String),
      'EX',
      86_400,
    );
  });

  it('returns a cached result without calling Steam again', async () => {
    const redis = fakeRedis();
    redis.store.set(
      'steam-friend-check:76561198000000001:76561198000000002',
      JSON.stringify({ inFriend: false, reason: null }),
    );
    const fetchMock = vi.fn();
    const result = await fetchSteamFriendCheck(76561198000000002n, 76561198000000001n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: false, reason: null, cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a private friends list to null/private_profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis: fakeRedis(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.inFriend).toBeNull();
    expect(result.reason).toBe('private_profile');
  });
});
