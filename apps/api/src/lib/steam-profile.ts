import type Redis from 'ioredis';

export interface SteamProfile {
  persona: string;
  avatarUrl: string;
  /**
   * `communityvisibilitystate`: 1 = private, 3 = public. `null` when Steam
   * omitted it. Added by INT-1 (#76).
   */
  visibility: number | null;
  /**
   * `timecreated` — Steam account creation time in Unix seconds. Steam only
   * returns it for public profiles, so `null` is the normal private-profile
   * answer. Added by INT-1 (#76).
   */
  createdAt: number | null;
}

export interface FetchSteamProfileDeps {
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
}

const CACHE_PREFIX = 'steam-profile:';
const CACHE_TTL_SECONDS = 3600;

export async function fetchSteamProfile(
  steamId64: bigint,
  deps: FetchSteamProfileDeps,
): Promise<SteamProfile | null> {
  if (!deps.apiKey) return null;
  const key = `${CACHE_PREFIX}${steamId64}`;
  const cached = await deps.redis.get(key);
  if (cached) {
    try {
      // Entries written before INT-1 (#76) carry only persona/avatarUrl; the
      // TTL is an hour, so rather than invalidate them we widen them here.
      const parsed = JSON.parse(cached) as Partial<SteamProfile>;
      return {
        persona: parsed.persona ?? '',
        avatarUrl: parsed.avatarUrl ?? '',
        visibility: typeof parsed.visibility === 'number' ? parsed.visibility : null,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
      };
    } catch {
      // corrupt cache — fall through and refetch
    }
  }
  const f = deps.fetch ?? fetch;
  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamids', String(steamId64));
  const res = await f(url);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    response?: {
      players?: {
        personaname?: string;
        avatarfull?: string;
        communityvisibilitystate?: number;
        timecreated?: number;
      }[];
    };
  };
  const player = json.response?.players?.[0];
  if (!player) return null;
  const profile: SteamProfile = {
    persona: player.personaname ?? '',
    avatarUrl: player.avatarfull ?? '',
    visibility: Number.isFinite(player.communityvisibilitystate)
      ? Number(player.communityvisibilitystate)
      : null,
    createdAt: Number.isFinite(player.timecreated) ? Number(player.timecreated) : null,
  };
  await deps.redis.set(key, JSON.stringify(profile), 'EX' as never, CACHE_TTL_SECONDS as never);
  return profile;
}
