import type { RconPlayer } from './parse-list-players.js';

export interface RosterEntry {
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

export interface RosterSnapshot {
  entries: RosterEntry[];
  firstSeen: Map<string, string>;
}

export function buildRoster(
  players: RconPlayer[],
  previousFirstSeen: Map<string, string>,
  polledAt: string,
): RosterSnapshot {
  const firstSeen = new Map<string, string>();
  const entries = players.map((player) => {
    const seenAt = previousFirstSeen.get(player.eos_id) ?? polledAt;
    firstSeen.set(player.eos_id, seenAt);
    return {
      rcon_id: player.rcon_id,
      eos_id: player.eos_id,
      steam_id64: player.steam_id64,
      name: player.name,
      team_id: player.team_id,
      squad_id: player.squad_id,
      is_leader: player.is_leader ?? false,
      role: player.role,
      first_seen_at: seenAt,
    };
  });
  return { entries, firstSeen };
}
