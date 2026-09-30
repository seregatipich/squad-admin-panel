import type Redis from 'ioredis';

export interface SteamProfile {
  persona: string;
  avatarUrl: string;
  visibility: number | null;
  createdAt: number | null;
}

export interface SteamBanInfo {
  steamId64: string;
  communityBanned: boolean;
  vacBanned: boolean;
  vacBanCount: number;
  gameBanCount: number;
  daysSinceLastBan: number | null;
  economyBan: string | null;
}

export interface SteamOwnedGames {
  ownsSquad: boolean | null;
  playtimeMinutes: number | null;
}

export interface SteamApiDeps {
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
  /**
   * Deadline for each Steam Web API request, response body included
   * (default {@link STEAM_REQUEST_TIMEOUT_MS}). On expiry the request is
   * aborted with a `TimeoutError` and handled like any other failed request
   * (its batch is skipped; the call resolves `null` when nothing was
   * recovered) instead of waiting out undici's 300 s default against a hung
   * api.steampowered.com.
   */
  timeoutMs?: number;
}

export const STEAM_BATCH_SIZE = 100;
export const STEAM_BANS_BATCH_SIZE = STEAM_BATCH_SIZE;
export const SQUAD_APP_ID = 393380;
/** Default per-request deadline for Steam Web API calls. */
export const STEAM_REQUEST_TIMEOUT_MS = 10_000;

const PROFILE_CACHE_PREFIX = 'steam-profile:';
const PROFILE_CACHE_TTL_SECONDS = 60 * 60;
const BANS_CACHE_PREFIX = 'steam-bans:';
const BANS_CACHE_TTL_SECONDS = 6 * 60 * 60;
const OWNED_GAMES_CACHE_PREFIX = 'steam-owned-games:';
const OWNED_GAMES_CACHE_TTL_SECONDS = 24 * 60 * 60;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Issues one Steam Web API GET bounded by `deps.timeoutMs`. The abort signal
 * also covers reading the body, so a stalled `response.json()` is cut too.
 */
function steamGet(url: URL, deps: SteamApiDeps): Promise<Response> {
  const request = deps.fetch ?? fetch;
  return request(url, {
    signal: AbortSignal.timeout(deps.timeoutMs ?? STEAM_REQUEST_TIMEOUT_MS),
  });
}

function uniqueIds(steamIds: readonly bigint[]): string[] {
  return [...new Set(steamIds.map(String))];
}

function parseProfile(value: string): SteamProfile | null {
  try {
    const parsed = JSON.parse(value) as Partial<SteamProfile>;
    return {
      persona: parsed.persona ?? '',
      avatarUrl: parsed.avatarUrl ?? '',
      visibility: typeof parsed.visibility === 'number' ? parsed.visibility : null,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
    };
  } catch {
    return null;
  }
}

/** Validates a value parsed from the bans cache actually has the SteamBanInfo shape. */
function isSteamBanInfo(value: unknown): value is SteamBanInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.steamId64 === 'string' &&
    typeof v.communityBanned === 'boolean' &&
    typeof v.vacBanned === 'boolean' &&
    typeof v.vacBanCount === 'number' &&
    typeof v.gameBanCount === 'number' &&
    (v.daysSinceLastBan === null || typeof v.daysSinceLastBan === 'number') &&
    (v.economyBan === null || typeof v.economyBan === 'string')
  );
}

function parseCachedBan(value: string): SteamBanInfo | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isSteamBanInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Validates a value parsed from the owned-games cache actually has the SteamOwnedGames shape. */
function isSteamOwnedGames(value: unknown): value is SteamOwnedGames {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.ownsSquad === null || typeof v.ownsSquad === 'boolean') &&
    (v.playtimeMinutes === null || typeof v.playtimeMinutes === 'number')
  );
}

function parseCachedOwnedGames(value: string): SteamOwnedGames | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isSteamOwnedGames(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchSteamProfiles(
  steamIds: readonly bigint[],
  deps: SteamApiDeps,
): Promise<Map<string, SteamProfile> | null> {
  if (!deps.apiKey) return null;

  const result = new Map<string, SteamProfile>();
  const cold: string[] = [];
  for (const id of uniqueIds(steamIds)) {
    const cached = await deps.redis.get(`${PROFILE_CACHE_PREFIX}${id}`);
    if (cached) {
      const profile = parseProfile(cached);
      if (profile) {
        result.set(id, profile);
        continue;
      }
    }
    cold.push(id);
  }

  let hadFailure = false;
  for (const batch of chunk(cold, STEAM_BATCH_SIZE)) {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', deps.apiKey);
    url.searchParams.set('steamids', batch.join(','));
    try {
      const response = await steamGet(url, deps);
      if (!response.ok) {
        hadFailure = true;
        continue;
      }
      const payload = (await response.json()) as {
        response?: {
          players?: Array<{
            steamid?: string;
            personaname?: string;
            avatarfull?: string;
            communityvisibilitystate?: number;
            timecreated?: number;
          }>;
        };
      };
      for (const raw of payload.response?.players ?? []) {
        if (!raw.steamid) continue;
        const profile: SteamProfile = {
          persona: raw.personaname ?? '',
          avatarUrl: raw.avatarfull ?? '',
          visibility: Number.isFinite(raw.communityvisibilitystate)
            ? Number(raw.communityvisibilitystate)
            : null,
          createdAt: Number.isFinite(raw.timecreated) ? Number(raw.timecreated) : null,
        };
        result.set(raw.steamid, profile);
        await deps.redis.set(
          `${PROFILE_CACHE_PREFIX}${raw.steamid}`,
          JSON.stringify(profile),
          'EX',
          PROFILE_CACHE_TTL_SECONDS,
        );
      }
    } catch {
      // A batch that throws (network error, non-JSON response body, …) is
      // skipped rather than discarding the results of earlier batches/cache.
      hadFailure = true;
    }
  }
  // Only report total failure when nothing at all was recovered, so callers
  // keep their existing "null means the whole call failed" contract; a
  // partial success from other batches/the cache is returned instead of
  // being thrown away.
  if (hadFailure && result.size === 0) return null;
  return result;
}

export async function fetchSteamProfile(
  steamId64: bigint,
  deps: SteamApiDeps,
): Promise<SteamProfile | null> {
  const profiles = await fetchSteamProfiles([steamId64], deps);
  return profiles?.get(String(steamId64)) ?? null;
}

interface RawBanEntry {
  SteamId?: string;
  CommunityBanned?: boolean;
  VACBanned?: boolean;
  NumberOfVACBans?: number;
  DaysSinceLastBan?: number;
  NumberOfGameBans?: number;
  EconomyBan?: string;
}

function normaliseBan(raw: RawBanEntry): SteamBanInfo | null {
  if (!raw.SteamId) return null;
  return {
    steamId64: raw.SteamId,
    communityBanned: raw.CommunityBanned === true,
    vacBanned: raw.VACBanned === true,
    vacBanCount: Number.isFinite(raw.NumberOfVACBans) ? Number(raw.NumberOfVACBans) : 0,
    gameBanCount: Number.isFinite(raw.NumberOfGameBans) ? Number(raw.NumberOfGameBans) : 0,
    daysSinceLastBan: Number.isFinite(raw.DaysSinceLastBan) ? Number(raw.DaysSinceLastBan) : null,
    economyBan: typeof raw.EconomyBan === 'string' ? raw.EconomyBan : null,
  };
}

export async function fetchSteamBans(
  steamIds: readonly bigint[],
  deps: SteamApiDeps,
): Promise<Map<string, SteamBanInfo> | null> {
  if (!deps.apiKey) return null;

  const result = new Map<string, SteamBanInfo>();
  const cold: string[] = [];
  for (const id of uniqueIds(steamIds)) {
    const cached = await deps.redis.get(`${BANS_CACHE_PREFIX}${id}`);
    const info = cached ? parseCachedBan(cached) : null;
    if (info) {
      result.set(id, info);
      continue;
    }
    cold.push(id);
  }

  let hadFailure = false;
  for (const batch of chunk(cold, STEAM_BANS_BATCH_SIZE)) {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/');
    url.searchParams.set('key', deps.apiKey);
    url.searchParams.set('steamids', batch.join(','));
    try {
      const response = await steamGet(url, deps);
      if (!response.ok) {
        hadFailure = true;
        continue;
      }
      const payload = (await response.json()) as { players?: RawBanEntry[] };
      for (const raw of payload.players ?? []) {
        const info = normaliseBan(raw);
        if (!info) continue;
        result.set(info.steamId64, info);
        await deps.redis.set(
          `${BANS_CACHE_PREFIX}${info.steamId64}`,
          JSON.stringify(info),
          'EX',
          BANS_CACHE_TTL_SECONDS,
        );
      }
    } catch {
      hadFailure = true;
    }
  }
  if (hadFailure && result.size === 0) return null;
  return result;
}

export async function fetchSteamOwnedGames(
  steamId64: bigint,
  deps: SteamApiDeps,
): Promise<SteamOwnedGames | null> {
  if (!deps.apiKey) return null;

  const key = `${OWNED_GAMES_CACHE_PREFIX}${steamId64}`;
  const cached = await deps.redis.get(key);
  if (cached) {
    const info = parseCachedOwnedGames(cached);
    if (info) return info;
  }

  const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamid', String(steamId64));
  url.searchParams.set('include_appinfo', 'false');
  url.searchParams.set('include_played_free_games', 'true');
  url.searchParams.set('appids_filter[0]', String(SQUAD_APP_ID));

  let response: Response;
  let payload: { response?: { games?: Array<{ appid?: number; playtime_forever?: number }> } };
  try {
    response = await steamGet(url, deps);
    if (!response.ok) return null;
    payload = (await response.json()) as {
      response?: { games?: Array<{ appid?: number; playtime_forever?: number }> };
    };
  } catch {
    return null;
  }
  const games = payload.response?.games;
  const squad = games?.find((game) => game.appid === SQUAD_APP_ID);
  const result: SteamOwnedGames = Array.isArray(games)
    ? {
        ownsSquad: squad !== undefined,
        playtimeMinutes: Number.isFinite(squad?.playtime_forever)
          ? Number(squad?.playtime_forever)
          : null,
      }
    : { ownsSquad: null, playtimeMinutes: null };

  await deps.redis.set(key, JSON.stringify(result), 'EX', OWNED_GAMES_CACHE_TTL_SECONDS);
  return result;
}
