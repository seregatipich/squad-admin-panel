import type Redis from 'ioredis';

export type SteamFriendCheckReason = 'private_profile' | 'no_steam_id' | 'api_key_missing';

export interface SteamFriendCheckResult {
  inFriend: boolean | null;
  reason: SteamFriendCheckReason | null;
  cached: boolean;
}

export interface FetchSteamFriendCheckDeps {
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
}

const CACHE_PREFIX = 'steam-friend-check:';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function cacheKey(first: bigint, second: bigint): string {
  const ids = [String(first), String(second)].sort();
  return `${CACHE_PREFIX}${ids[0]}:${ids[1]}`;
}

/**
 * Checks one Steam account's friends list for the other account. Both
 * positive/negative answers and privacy failures are cached for 24 hours so a
 * button click does not repeatedly hit Steam. The caller supplies the
 * configured key; an empty key never makes an external request.
 */
export async function fetchSteamFriendCheck(
  firstSteamId64: bigint,
  secondSteamId64: bigint,
  deps: FetchSteamFriendCheckDeps,
): Promise<SteamFriendCheckResult> {
  if (!deps.apiKey) {
    return { inFriend: null, reason: 'api_key_missing', cached: false };
  }

  const key = cacheKey(firstSteamId64, secondSteamId64);
  const cached = await deps.redis.get(key);
  if (cached) {
    try {
      const result = JSON.parse(cached) as Omit<SteamFriendCheckResult, 'cached'>;
      if (typeof result.inFriend === 'boolean' || result.inFriend === null) {
        return { ...result, cached: true };
      }
    } catch {
      // Corrupt cache — fall through and refetch.
    }
  }

  const url = new URL('https://api.steampowered.com/ISteamUser/GetFriendList/v0001/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamid', String(firstSteamId64));
  url.searchParams.set('relationship', 'friend');

  const response = await (deps.fetch ?? fetch)(url);
  let result: Omit<SteamFriendCheckResult, 'cached'>;
  if (!response.ok) {
    result = { inFriend: null, reason: 'private_profile' };
  } else {
    const body = (await response.json()) as {
      friendslist?: { friends?: Array<{ steamid?: string }> };
    };
    const friends = body.friendslist?.friends;
    result = friends
      ? {
          inFriend: friends.some((friend) => friend.steamid === String(secondSteamId64)),
          reason: null,
        }
      : { inFriend: null, reason: 'private_profile' };
  }

  await deps.redis.set(key, JSON.stringify(result), 'EX' as never, CACHE_TTL_SECONDS as never);
  return { ...result, cached: false };
}
