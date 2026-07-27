import type Redis from 'ioredis';

/** Steam application id of Squad. */
export const SQUAD_APP_ID = 393380;

export interface SteamOwnedGames {
  /**
   * `true`/`false` when Steam disclosed the game list, `null` when it did not
   * (private profile) — "unknown", never "does not own".
   */
  ownsSquad: boolean | null;
  /** `playtime_forever` in minutes for Squad, `null` when unknown. */
  playtimeMinutes: number | null;
}

export interface FetchSteamOwnedGamesDeps {
  /** Operator's Steam Web API key; an empty key disables all outbound calls. */
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
}

const CACHE_PREFIX = 'steam-owned-games:';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

interface RawOwnedGames {
  response?: { games?: { appid?: number; playtime_forever?: number }[] };
}

/**
 * Reads Squad ownership and playtime from `IPlayerService/GetOwnedGames/v1`.
 *
 * The endpoint's response shape is not officially documented, so parsing is
 * deliberately defensive and distinguishes two different empty answers:
 * a `games` array that exists but does not contain {@link SQUAD_APP_ID} means
 * the account genuinely does not own Squad, while a response with **no**
 * `games` key at all means Steam withheld the library (private profile) and
 * ownership stays `null`. `appids_filter[0]` narrows the answer server-side;
 * if Steam ignores the parameter the full library comes back and the lookup
 * still resolves correctly.
 *
 * The answer is cached for 24 hours; a caller that gets `null` must treat it
 * as an error, not as "does not own".
 *
 * @param steamId64 The account to inspect.
 * @param deps Steam API key, Redis for the cache, and an optional `fetch` double.
 * @returns The ownership snapshot, or `null` when no API key is configured or
 *   Steam answered non-OK.
 */
export async function fetchSteamOwnedGames(
  steamId64: bigint,
  deps: FetchSteamOwnedGamesDeps,
): Promise<SteamOwnedGames | null> {
  if (!deps.apiKey) return null;

  const key = `${CACHE_PREFIX}${steamId64}`;
  const cached = await deps.redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as SteamOwnedGames;
    } catch {
      // Corrupt cache — fall through and refetch.
    }
  }

  const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamid', String(steamId64));
  url.searchParams.set('include_appinfo', 'false');
  url.searchParams.set('include_played_free_games', 'true');
  url.searchParams.set('appids_filter[0]', String(SQUAD_APP_ID));

  const res = await (deps.fetch ?? fetch)(url);
  if (!res.ok) return null;
  const json = (await res.json()) as RawOwnedGames;
  const games = json.response?.games;

  let result: SteamOwnedGames;
  if (!Array.isArray(games)) {
    result = { ownsSquad: null, playtimeMinutes: null };
  } else {
    const squad = games.find((game) => game?.appid === SQUAD_APP_ID);
    result = {
      ownsSquad: squad !== undefined,
      playtimeMinutes: Number.isFinite(squad?.playtime_forever)
        ? Number(squad?.playtime_forever)
        : null,
    };
  }

  await deps.redis.set(key, JSON.stringify(result), 'EX' as never, CACHE_TTL_SECONDS as never);
  return result;
}
