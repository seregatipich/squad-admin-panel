import { type SquadCrown, squadCrownSchema } from '@squad/shared-types';

export interface StoredRosterEntry {
  rcon_id: number;
  eos_id: string;
  steam_id64: string | null;
  name: string;
  team_id: number | null;
  squad_id: number | null;
  is_leader: boolean;
  role: string | null;
  first_seen_at: string;
}

export interface StoredRoster {
  server_id: string;
  polled_at: string;
  players: StoredRosterEntry[];
}

/** One `ListSquads` row as worker-rcon caches it under `rcon:squads:{serverId}`. */
export interface StoredSquadEntry {
  team_id: number;
  team_name: string;
  squad_id: number;
  name: string;
  size: number;
  locked: boolean;
  creator_name: string;
  creator_eos_id: string | null;
  creator_steam_id64: string | null;
  is_command_squad: boolean;
}

export interface StoredSquads {
  server_id: string;
  polled_at: string;
  squads: StoredSquadEntry[];
}

export interface PlayerIdentity {
  id: string;
  eosId: string | null;
  steamId64: bigint | null;
}

export interface RosterApiEntry {
  player_id: string | null;
  rcon_id: number;
  eos_id: string;
  steam_id64: string | null;
  name: string;
  team_id: number | null;
  squad_id: number | null;
  is_leader: boolean;
  role: string | null;
  first_seen_at: string | null;
  /**
   * The player's squad-creator crown for the current match, from worker-rcon's
   * `rcon:squad-crowns:{id}` hash; `null` for a player without one.
   */
  squad_crown: SquadCrown | null;
}

/** A side of the match as `ListSquads` names it: `Team ID: 1 (United States Army)`. */
export interface RosterApiTeam {
  team_id: number;
  name: string;
}

/** Squad metadata the roster rows themselves do not carry: name, lock, declared size. */
export interface RosterApiSquad {
  team_id: number;
  squad_id: number;
  name: string;
  size: number;
  locked: boolean;
  is_command_squad: boolean;
}

export interface RosterApiResponse {
  polled_at: string | null;
  players: RosterApiEntry[];
  /**
   * Empty when the squads snapshot is missing — it expires 90 s after the
   * last successful poll and is skipped when `ListSquads` fails, so the UI
   * must render the roster from `players` alone and treat these as decoration.
   */
  teams: RosterApiTeam[];
  squads: RosterApiSquad[];
}

/**
 * Parses the cached `rcon:roster:{serverId}` value. Returns null for a missing
 * key, malformed JSON, or a payload without a `players` array, so a stale or
 * hand-edited cache entry degrades to "no roster" instead of a 500.
 */
export function parseStoredRoster(raw: string | null): StoredRoster | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredRoster;
    return Array.isArray(parsed?.players) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseStoredSquads(raw: string | null): StoredSquads | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSquads;
    return Array.isArray(parsed?.squads) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parses `HGETALL rcon:squad-crowns:{serverId}` into crowns keyed by creator
 * EOS id. A field that is not valid JSON or does not match the contract is
 * dropped on its own, so one corrupt entry never hides the rest of the roster.
 */
export function parseStoredCrowns(raw: Record<string, string> | null): Map<string, SquadCrown> {
  const crowns = new Map<string, SquadCrown>();
  for (const [eosId, value] of Object.entries(raw ?? {})) {
    try {
      const parsed = squadCrownSchema.safeParse(JSON.parse(value));
      if (parsed.success) crowns.set(eosId, parsed.data);
    } catch {
      // malformed field: this player simply shows no crown
    }
  }
  return crowns;
}

/** A SteamID64 is exactly 17 decimal digits. */
const STEAM_ID64_PATTERN = /^\d{17}$/;

/**
 * Collects the identities to resolve against `players`. A malformed
 * `steam_id64` is skipped rather than passed to `BigInt`, which would throw.
 */
export function collectRosterLookups(entries: StoredRosterEntry[]): {
  eosIds: string[];
  steamIds: bigint[];
} {
  const eosIds = entries.map((entry) => entry.eos_id).filter((id): id is string => !!id);
  const steamIds = entries
    .map((entry) => entry.steam_id64)
    .filter((id): id is string => typeof id === 'string' && STEAM_ID64_PATTERN.test(id))
    .map((id) => BigInt(id));
  return { eosIds, steamIds };
}

/**
 * Projects the cached `ListSquads` rows onto the response: one `teams` entry
 * per distinct team id (first name wins) and one `squads` entry per row,
 * without the creator identity — the roster rows already say who leads.
 */
export function buildSquadMeta(stored: StoredSquads | null): {
  teams: RosterApiTeam[];
  squads: RosterApiSquad[];
} {
  if (!stored) return { teams: [], squads: [] };
  const teams = new Map<number, string>();
  const squads: RosterApiSquad[] = [];
  for (const squad of stored.squads) {
    if (typeof squad?.team_id !== 'number' || typeof squad.squad_id !== 'number') continue;
    if (!teams.has(squad.team_id)) teams.set(squad.team_id, squad.team_name ?? '');
    squads.push({
      team_id: squad.team_id,
      squad_id: squad.squad_id,
      name: squad.name ?? '',
      size: typeof squad.size === 'number' ? squad.size : 0,
      locked: squad.locked === true,
      is_command_squad: squad.is_command_squad === true,
    });
  }
  return {
    teams: [...teams.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([team_id, name]) => ({ team_id, name })),
    squads,
  };
}

export function buildRosterResponse(
  stored: StoredRoster | null,
  identities: PlayerIdentity[],
  storedSquads: StoredSquads | null = null,
  crowns: ReadonlyMap<string, SquadCrown> = new Map(),
): RosterApiResponse {
  const meta = buildSquadMeta(storedSquads);
  if (!stored) return { polled_at: null, players: [], ...meta };
  const entries = stored.players ?? [];
  if (entries.length === 0) return { polled_at: stored.polled_at ?? null, players: [], ...meta };

  const idByEos = new Map<string, string>();
  const idBySteam = new Map<string, string>();
  for (const identity of identities) {
    if (identity.eosId) idByEos.set(identity.eosId, identity.id);
    if (identity.steamId64 != null) idBySteam.set(identity.steamId64.toString(), identity.id);
  }

  return {
    polled_at: stored.polled_at ?? null,
    players: entries.map((entry) => ({
      player_id:
        idByEos.get(entry.eos_id) ??
        (entry.steam_id64 ? (idBySteam.get(entry.steam_id64) ?? null) : null),
      rcon_id: entry.rcon_id,
      eos_id: entry.eos_id,
      steam_id64: entry.steam_id64 ?? null,
      name: entry.name,
      team_id: entry.team_id ?? null,
      squad_id: entry.squad_id ?? null,
      is_leader: entry.is_leader ?? false,
      role: entry.role ?? null,
      first_seen_at: entry.first_seen_at ?? null,
      squad_crown: crowns.get(entry.eos_id) ?? null,
    })),
    ...meta,
  };
}
