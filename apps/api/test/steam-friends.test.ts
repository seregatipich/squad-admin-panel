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

  it('does not cache a transient Steam failure as a private profile (#68)', async () => {
    const redis = fakeRedis();
    for (const status of [429, 500, 503, 403]) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) });
      const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
        apiKey: 'KEY',
        redis,
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(result).toEqual({ inFriend: null, reason: 'steam_unavailable', cached: false });
    }
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('reports steam_unavailable instead of throwing on a non-JSON body (#68)', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: null, reason: 'steam_unavailable', cached: false });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('reports steam_unavailable when the request fails or times out (#68)', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: null, reason: 'steam_unavailable', cached: false });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the second player's list when the first is private (#68)", async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.searchParams.get('steamid') === '76561198000000001') {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ friendslist: { friends: [{ steamid: '76561198000000001' }] } }),
      };
    });
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: true, reason: null, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches private_profile only when both friends lists are private (401)', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const result = await fetchSteamFriendCheck(76561198000000001n, 76561198000000002n, {
      apiKey: 'KEY',
      redis,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ inFriend: null, reason: 'private_profile', cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});
