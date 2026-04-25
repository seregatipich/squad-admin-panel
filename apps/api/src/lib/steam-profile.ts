import type Redis from 'ioredis';

export interface SteamProfile {
  persona: string;
  avatarUrl: string;
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
      return JSON.parse(cached) as SteamProfile;
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
    response?: { players?: { personaname?: string; avatarfull?: string }[] };
  };
  const player = json.response?.players?.[0];
  if (!player) return null;
  const profile: SteamProfile = {
    persona: player.personaname ?? '',
    avatarUrl: player.avatarfull ?? '',
  };
  await deps.redis.set(key, JSON.stringify(profile), 'EX' as never, CACHE_TTL_SECONDS as never);
  return profile;
}
