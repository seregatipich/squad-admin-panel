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

/** A side of the match as `ListSquads` names it — «United States Army». */
export interface RosterTeamMeta {
  team_id: number;
  name: string;
}

/** What `ListSquads` knows about a squad and `ListPlayers` does not: name, lock, declared size. */
export interface RosterSquadMeta {
  team_id: number;
  squad_id: number;
  name: string;
  size: number;
  locked: boolean;
  is_command_squad: boolean;
}

export interface RosterResponse {
  polled_at: string | null;
  players: RosterPlayer[];
  /**
   * Squad metadata is decoration: the worker's squads snapshot expires 90 s
   * after the last successful poll, so both lists may be missing or empty
   * while `players` is still fresh. Everything below renders without them.
   */
  teams?: RosterTeamMeta[];
  squads?: RosterSquadMeta[];
}

/** Squad caps every squad, Command Squad included, at nine players. */
export const SQUAD_MAX_SIZE = 9;

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

/**
 * The kit a player runs, cut out of Squad's role id: `USA_Rifleman_01` →
 * «Rifleman», `CAF_SL_01` → «SL». The leading faction and the trailing variant
 * number carry nothing the row does not already show.
 */
export function kitLabel(role: string | null): string | null {
  if (!role) return null;
  const parts = role.split('_').filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.length > 1) parts.shift();
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.join(' ');
}

export interface SquadGroup {
  team_id: number | null;
  squad_id: number | null;
  players: RosterPlayer[];
  /** The squad's current leader, if any — used to fill `{player}` in message templates. */
  leader: RosterPlayer | null;
  /** From the squads snapshot; `null` for the unassigned pool or when the snapshot is stale. */
  name: string | null;
  locked: boolean;
  is_command_squad: boolean;
}

/**
 * Groups a (sorted) roster into per-(team, squad) blocks. Players with no
 * squad (`squad_id === null`, e.g. "Unassigned") are grouped together per
 * team, but never get a messaging target since Squad has no "message the
 * unassigned pool" RCON command. Call {@link sortRoster} first so groups and
 * the players inside them come out in a stable, readable order.
 *
 * `squads` (the `ListSquads` snapshot) only decorates the groups with a name
 * and lock state; a squad that has players but no snapshot row still shows up.
 */
export function groupRosterBySquad(
  list: RosterPlayer[],
  squads: readonly RosterSquadMeta[] = [],
): SquadGroup[] {
  const groups: SquadGroup[] = [];
  const indexByKey = new Map<string, number>();
  const metaByKey = new Map<string, RosterSquadMeta>();
  for (const squad of squads) metaByKey.set(`${squad.team_id}:${squad.squad_id}`, squad);
  for (const player of list) {
    const key = `${player.team_id}:${player.squad_id}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      const meta = player.squad_id == null ? undefined : metaByKey.get(key);
      groups.push({
        team_id: player.team_id,
        squad_id: player.squad_id,
        players: [],
        leader: null,
        name: meta?.name ?? null,
        locked: meta?.locked ?? false,
        is_command_squad: meta?.is_command_squad ?? false,
      });
    }
    const group = groups[idx];
    if (!group) continue;
    group.players.push(player);
    if (player.is_leader) group.leader = player;
  }
  return groups;
}

/** One team's column: its squads in display order plus the unassigned pool last. */
export interface TeamColumn {
  team_id: number;
  /** Faction name from the squads snapshot; `null` when unknown — show «Команда N». */
  name: string | null;
  squads: SquadGroup[];
  player_count: number;
}

export interface RosterByTeam {
  /** Always at least teams 1 and 2, in that order, even while one of them is empty. */
  teams: TeamColumn[];
  /** Roster rows without a `team_id` — they belong to neither column. */
  unaffiliated: RosterPlayer[];
}

const MATCH_TEAM_IDS = [1, 2] as const;

/**
 * Splits a (sorted) roster into one column per team, the way the squad
 * screen in game lays it out: the Command Squad on top, then squads by
 * number, unassigned players at the bottom. Both match teams are always
 * present so the two-column layout does not collapse while one side is
 * still empty during seeding.
 */
export function groupRosterByTeam(
  list: RosterPlayer[],
  meta: { teams?: readonly RosterTeamMeta[]; squads?: readonly RosterSquadMeta[] } = {},
): RosterByTeam {
  const nameByTeam = new Map<number, string>();
  for (const team of meta.teams ?? []) {
    if (team.name.trim().length > 0) nameByTeam.set(team.team_id, team.name);
  }

  const teamIds = new Set<number>(MATCH_TEAM_IDS);
  for (const player of list) if (player.team_id != null) teamIds.add(player.team_id);

  const groups = groupRosterBySquad(list, meta.squads ?? []);
  const teams: TeamColumn[] = [...teamIds]
    .sort((left, right) => left - right)
    .map((teamId) => {
      const squads = groups
        .filter((group) => group.team_id === teamId)
        .sort((left, right) => {
          if (left.squad_id == null) return right.squad_id == null ? 0 : 1;
          if (right.squad_id == null) return -1;
          if (left.is_command_squad !== right.is_command_squad) {
            return left.is_command_squad ? -1 : 1;
          }
          return left.squad_id - right.squad_id;
        });
      return {
        team_id: teamId,
        name: nameByTeam.get(teamId) ?? null,
        squads,
        player_count: squads.reduce((sum, group) => sum + group.players.length, 0),
      };
    });

  return { teams, unaffiliated: list.filter((player) => player.team_id == null) };
}

/**
 * Team, then squad, then the squad leader ahead of everyone else, then name.
 * The leader always heads their squad, as on the in-game squad screen.
 */
export function sortRoster(list: RosterPlayer[]): RosterPlayer[] {
  return [...list].sort((left, right) => {
    const leftTeam = left.team_id ?? Number.MAX_SAFE_INTEGER;
    const rightTeam = right.team_id ?? Number.MAX_SAFE_INTEGER;
    if (leftTeam !== rightTeam) return leftTeam - rightTeam;
    const leftSquad = left.squad_id ?? Number.MAX_SAFE_INTEGER;
    const rightSquad = right.squad_id ?? Number.MAX_SAFE_INTEGER;
    if (leftSquad !== rightSquad) return leftSquad - rightSquad;
    if (left.is_leader !== right.is_leader) return left.is_leader ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
