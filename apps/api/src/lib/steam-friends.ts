import type Redis from 'ioredis';

/**
 * Why a friend check has no yes/no answer:
 * - `private_profile` — Steam hides both players' friends lists;
 * - `steam_unavailable` — Steam failed, timed out or answered garbage; retry later;
 * - `no_steam_id` / `api_key_missing` — the check could not be attempted.
 */
export type SteamFriendCheckReason =
  | 'private_profile'
  | 'steam_unavailable'
  | 'no_steam_id'
  | 'api_key_missing';

export interface SteamFriendCheckResult {
  inFriend: boolean | null;
  reason: SteamFriendCheckReason | null;
  cached: boolean;
}

export interface FetchSteamFriendCheckDeps {
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
  /** Per-request timeout for the Steam call; defaults to {@link STEAM_FRIENDS_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const CACHE_PREFIX = 'steam-friend-check:';
const CACHE_TTL_SECONDS = 24 * 60 * 60;
export const STEAM_FRIENDS_TIMEOUT_MS = 5_000;

type FriendListLookup =
  | { kind: 'list'; steamIds: Set<string> }
  | { kind: 'private' }
  | { kind: 'unavailable' };

function cacheKey(first: bigint, second: bigint): string {
  const ids = [String(first), String(second)].sort();
  return `${CACHE_PREFIX}${ids[0]}:${ids[1]}`;
}

/**
 * Fetches one account's friends list. Steam answers 401 for a private list
 * (and a 200 without `friendslist` for some hidden profiles); every other
 * failure — non-2xx, network error, timeout, a body that is not JSON — is
 * reported as `unavailable` so it is never mistaken for a privacy setting.
 */
async function fetchFriendList(
  steamId64: bigint,
  deps: FetchSteamFriendCheckDeps,
): Promise<FriendListLookup> {
  const url = new URL('https://api.steampowered.com/ISteamUser/GetFriendList/v0001/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamid', String(steamId64));
  url.searchParams.set('relationship', 'friend');
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? STEAM_FRIENDS_TIMEOUT_MS),
    });
    if (response.status === 401) return { kind: 'private' };
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as {
      friendslist?: { friends?: Array<{ steamid?: string }> };
    };
    const friends = body.friendslist?.friends;
    if (!friends) return { kind: 'private' };
    return {
      kind: 'list',
      steamIds: new Set(friends.flatMap((friend) => (friend.steamid ? [friend.steamid] : []))),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Checks whether two Steam accounts are friends. The first player's list is
 * read, and the second's when the first is private — friendship is mutual, so
 * either list answers the question for the symmetric cache key.
 *
 * Definitive answers (friend / not friend / both lists private) are cached for
 * 24 hours so a button click does not repeatedly hit Steam; a transient Steam
 * failure yields `steam_unavailable` and is not cached. An empty key never
 * makes an external request.
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

  let result: Omit<SteamFriendCheckResult, 'cached'> | null = null;
  let unavailable = false;
  for (const [owner, other] of [
    [firstSteamId64, secondSteamId64],
    [secondSteamId64, firstSteamId64],
  ] as const) {
    const lookup = await fetchFriendList(owner, deps);
    if (lookup.kind === 'list') {
      result = { inFriend: lookup.steamIds.has(String(other)), reason: null };
      break;
    }
    if (lookup.kind === 'unavailable') unavailable = true;
  }

  if (!result) {
    if (unavailable) return { inFriend: null, reason: 'steam_unavailable', cached: false };
    result = { inFriend: null, reason: 'private_profile' };
  }

  await deps.redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
  return { ...result, cached: false };
}
