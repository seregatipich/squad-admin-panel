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
