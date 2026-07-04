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
}

export interface RosterApiResponse {
  polled_at: string | null;
  players: RosterApiEntry[];
}

export function parseStoredRoster(raw: string | null): StoredRoster | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRoster;
  } catch {
    return null;
  }
}

export function collectRosterLookups(entries: StoredRosterEntry[]): {
  eosIds: string[];
  steamIds: bigint[];
} {
  const eosIds = entries.map((entry) => entry.eos_id).filter((id): id is string => !!id);
  const steamIds = entries
    .map((entry) => entry.steam_id64)
    .filter((id): id is string => !!id)
    .map((id) => BigInt(id));
  return { eosIds, steamIds };
}

export function buildRosterResponse(
  stored: StoredRoster | null,
  identities: PlayerIdentity[],
): RosterApiResponse {
  if (!stored) return { polled_at: null, players: [] };
  const entries = stored.players ?? [];
  if (entries.length === 0) return { polled_at: stored.polled_at ?? null, players: [] };

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
    })),
  };
}
