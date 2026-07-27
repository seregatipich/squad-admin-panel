import type Redis from 'ioredis';

/**
 * One player's ban state as reported by `ISteamUser/GetPlayerBans/v1`.
 *
 * Note the endpoint answers in **PascalCase**, unlike `GetPlayerSummaries`,
 * and `EconomyBan` is a *string* ('none' | 'probation' | 'banned'), not a
 * boolean — this shape is the normalised camelCase projection of that payload.
 */
export interface SteamBanInfo {
  /** Decimal SteamID64, as Steam echoes it back. */
  steamId64: string;
  communityBanned: boolean;
  vacBanned: boolean;
  vacBanCount: number;
  gameBanCount: number;
  /** Steam's `DaysSinceLastBan`; `null` when the field is absent. */
  daysSinceLastBan: number | null;
  /** Steam's `EconomyBan` string, passed through verbatim. */
  economyBan: string | null;
}

export interface FetchSteamBansDeps {
  /** Operator's Steam Web API key; an empty key disables all outbound calls. */
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
}

const CACHE_PREFIX = 'steam-bans:';
const CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * Largest number of SteamIDs put into a single `steamids=` request. Steam does
 * not document a limit for `GetPlayerBans`; 100 is the documented ceiling for
 * the sibling `GetPlayerSummaries` and is used here as the conservative bound.
 */
export const STEAM_BANS_BATCH_SIZE = 100;

interface RawBanEntry {
  SteamId?: string;
  CommunityBanned?: boolean;
  VACBanned?: boolean;
  NumberOfVACBans?: number;
  DaysSinceLastBan?: number;
  NumberOfGameBans?: number;
  EconomyBan?: string;
}

function normalise(raw: RawBanEntry): SteamBanInfo | null {
  if (typeof raw.SteamId !== 'string' || raw.SteamId.length === 0) return null;
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Reads VAC/game/community ban state for a set of Steam accounts.
 *
 * Each SteamID is cached individually for six hours, so a mixed request only
 * asks Steam about the ids that are actually cold, and the uncached remainder
 * is sent in batches of {@link STEAM_BANS_BATCH_SIZE}.
 *
 * @param steamIds SteamID64 values to look up; an empty list never calls Steam.
 * @param deps Steam API key, Redis for the cache, and an optional `fetch` double.
 * @returns A map keyed by decimal SteamID64. Ids Steam did not answer for are
 *   simply absent from the map. Returns `null` when no API key is configured
 *   (the mandatory no-key contract shared with `steam-profile.ts`) or when
 *   Steam answers non-OK — callers must treat `null` as "state unknown", never
 *   as "no bans".
 */
export async function fetchSteamBans(
  steamIds: readonly bigint[],
  deps: FetchSteamBansDeps,
): Promise<Map<string, SteamBanInfo> | null> {
  if (!deps.apiKey) return null;

  const result = new Map<string, SteamBanInfo>();
  const cold: string[] = [];
  for (const steamId of steamIds) {
    const id = String(steamId);
    if (result.has(id) || cold.includes(id)) continue;
    const cached = await deps.redis.get(`${CACHE_PREFIX}${id}`);
    if (cached) {
      try {
        result.set(id, JSON.parse(cached) as SteamBanInfo);
        continue;
      } catch {
        // Corrupt cache — fall through and refetch this id.
      }
    }
    cold.push(id);
  }
  if (cold.length === 0) return result;

  const f = deps.fetch ?? fetch;
  for (const batch of chunk(cold, STEAM_BANS_BATCH_SIZE)) {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/');
    url.searchParams.set('key', deps.apiKey);
    url.searchParams.set('steamids', batch.join(','));
    const res = await f(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { players?: RawBanEntry[] };
    for (const raw of json.players ?? []) {
      const info = normalise(raw);
      if (!info) continue;
      result.set(info.steamId64, info);
      await deps.redis.set(
        `${CACHE_PREFIX}${info.steamId64}`,
        JSON.stringify(info),
        'EX' as never,
        CACHE_TTL_SECONDS as never,
      );
    }
  }
  return result;
}
