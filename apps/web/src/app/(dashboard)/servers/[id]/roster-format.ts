export interface RosterPlayer {
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

export interface RosterResponse {
  polled_at: string | null;
  players: RosterPlayer[];
}

export function formatTimeOnServer(firstSeenAt: string | null, now: number): string {
  if (!firstSeenAt) return '—';
  const startedMs = new Date(firstSeenAt).getTime();
  if (Number.isNaN(startedMs)) return '—';
  const totalSeconds = Math.max(0, Math.floor((now - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}ч ${pad(minutes)}м`;
  if (minutes > 0) return `${minutes}м ${pad(seconds)}с`;
  return `${seconds}с`;
}

export function shortEos(eosId: string): string {
  if (eosId.length <= 12) return eosId;
  return `${eosId.slice(0, 8)}…${eosId.slice(-4)}`;
}

export function teamLabel(teamId: number | null): string {
  return teamId == null ? '—' : String(teamId);
}

export function squadLabel(squadId: number | null): string {
  return squadId == null ? '—' : String(squadId);
}

export interface SquadGroup {
  team_id: number | null;
  squad_id: number | null;
  players: RosterPlayer[];
  /** The squad's current leader, if any — used to fill `{player}` in message templates. */
  leader: RosterPlayer | null;
}

/**
 * Groups a (sorted) roster into per-(team, squad) blocks. Players with no
 * squad (`squad_id === null`, e.g. "Unassigned") are grouped together per
 * team, but never get a messaging target since Squad has no "message the
 * unassigned pool" RCON command. Call {@link sortRoster} first so groups and
 * the players inside them come out in a stable, readable order.
 */
export function groupRosterBySquad(list: RosterPlayer[]): SquadGroup[] {
  const groups: SquadGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const player of list) {
    const key = `${player.team_id}:${player.squad_id}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      groups.push({
        team_id: player.team_id,
        squad_id: player.squad_id,
        players: [],
        leader: null,
      });
    }
    const group = groups[idx];
    if (!group) continue;
    group.players.push(player);
    if (player.is_leader) group.leader = player;
  }
  return groups;
}

export function sortRoster(list: RosterPlayer[]): RosterPlayer[] {
  return [...list].sort((left, right) => {
    const leftTeam = left.team_id ?? Number.MAX_SAFE_INTEGER;
    const rightTeam = right.team_id ?? Number.MAX_SAFE_INTEGER;
    if (leftTeam !== rightTeam) return leftTeam - rightTeam;
    const leftSquad = left.squad_id ?? Number.MAX_SAFE_INTEGER;
    const rightSquad = right.squad_id ?? Number.MAX_SAFE_INTEGER;
    if (leftSquad !== rightSquad) return leftSquad - rightSquad;
    return left.name.localeCompare(right.name);
  });
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
