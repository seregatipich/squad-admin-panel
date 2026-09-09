import {
  type DatabaseClient,
  events,
  matches,
  matchPlayers,
  playerSessions,
  players,
} from '@squad/db';
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { MatchCommand } from '../parser/match.js';
import { applyMatchCombatStats, loadMatchCombatStats } from './combat.js';

export const DEFAULT_JOIN_GRACE_SECONDS = 60;

const POLL_KIND = 'rcon.players_polled';

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

export interface SessionInterval {
  playerId: string;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

export interface TeamSquad {
  team: number | null;
  squadName: string | null;
}

export interface MatchRosterEntry {
  playerId: string;
  joinedAt: Date;
  leftAt: Date | null;
  playSeconds: number;
  team: number | null;
  squadName: string | null;
}

export interface AssembleRosterInput {
  matchStart: Date;
  matchEnd: Date;
  sessions: SessionInterval[];
  teamSquadByPlayer?: Map<string, TeamSquad>;
}

interface Accumulator {
  joinedAtMs: number;
  lastLeftAtMs: number;
  overlapMs: number;
  presentAtEnd: boolean;
}

export function assembleMatchRoster(input: AssembleRosterInput): MatchRosterEntry[] {
  const startMs = input.matchStart.getTime();
  const endMs = input.matchEnd.getTime();
  if (endMs <= startMs) return [];

  const byPlayer = new Map<string, Accumulator>();

  for (const session of input.sessions) {
    const connectedMs = session.connectedAt.getTime();
    const spansEnd = session.disconnectedAt === null || session.disconnectedAt.getTime() >= endMs;
    const disconnectedMs =
      session.disconnectedAt === null ? endMs : session.disconnectedAt.getTime();

    const pieceStart = Math.max(connectedMs, startMs);
    const pieceEnd = Math.min(disconnectedMs, endMs);
    if (pieceEnd <= pieceStart) continue;

    const existing = byPlayer.get(session.playerId);
    if (!existing) {
      byPlayer.set(session.playerId, {
        joinedAtMs: pieceStart,
        lastLeftAtMs: pieceEnd,
        overlapMs: pieceEnd - pieceStart,
        presentAtEnd: spansEnd,
      });
      continue;
    }
    existing.joinedAtMs = Math.min(existing.joinedAtMs, pieceStart);
    existing.lastLeftAtMs = Math.max(existing.lastLeftAtMs, pieceEnd);
    existing.overlapMs += pieceEnd - pieceStart;
    existing.presentAtEnd = existing.presentAtEnd || spansEnd;
  }

  const entries: MatchRosterEntry[] = [];
  for (const [playerId, acc] of byPlayer) {
    const teamSquad = input.teamSquadByPlayer?.get(playerId);
    entries.push({
      playerId,
      joinedAt: new Date(acc.joinedAtMs),
      leftAt: acc.presentAtEnd ? null : new Date(acc.lastLeftAtMs),
      playSeconds: Math.floor(acc.overlapMs / 1000),
      team: teamSquad?.team ?? null,
      squadName: teamSquad?.squadName ?? null,
    });
  }

  entries.sort((a, b) => {
    const byJoin = a.joinedAt.getTime() - b.joinedAt.getTime();
    return byJoin !== 0 ? byJoin : a.playerId.localeCompare(b.playerId);
  });
  return entries;
}

export function filterRosterByPlaySeconds(
  entries: MatchRosterEntry[],
  minSeconds: number = DEFAULT_JOIN_GRACE_SECONDS,
): MatchRosterEntry[] {
  return entries.filter((entry) => entry.playSeconds >= minSeconds);
}

interface PollPlayer {
  steam_id64: string | null;
  eos_id: string | null;
  team_id: number | null;
  squad_id: number | null;
}

async function loadTeamSquadByPlayer(
  db: DatabaseClient,
  serverId: string,
  matchStart: Date,
  matchEnd: Date,
): Promise<Map<string, TeamSquad>> {
  const snapshot = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.serverId, serverId),
        eq(events.kind, POLL_KIND),
        gte(events.occurredAt, matchStart),
        lte(events.occurredAt, matchEnd),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(1);

  const result = new Map<string, TeamSquad>();
  const row = snapshot[0];
  if (!row) return result;

  const pollPlayers = ((row.payload as { players?: PollPlayer[] }).players ?? []).filter(
    (entry) => entry.steam_id64 !== null || entry.eos_id !== null,
  );
  if (pollPlayers.length === 0) return result;

  const steamIds = pollPlayers
    .map((entry) => entry.steam_id64)
    .filter((value): value is string => value !== null)
    .map((value) => BigInt(value));
  const eosIds = pollPlayers
    .map((entry) => entry.eos_id)
    .filter((value): value is string => value !== null);

  const conditions = [];
  if (steamIds.length > 0) conditions.push(inArray(players.steamId64, steamIds));
  if (eosIds.length > 0) conditions.push(inArray(players.eosId, eosIds));
  if (conditions.length === 0) return result;

  const resolved = await db
    .select({ id: players.id, steamId64: players.steamId64, eosId: players.eosId })
    .from(players)
    .where(or(...conditions));

  const playerBySteam = new Map<string, string>();
  const playerByEos = new Map<string, string>();
  for (const player of resolved) {
    if (player.steamId64 !== null) playerBySteam.set(player.steamId64.toString(), player.id);
    if (player.eosId !== null) playerByEos.set(player.eosId, player.id);
  }

  for (const entry of pollPlayers) {
    const playerId =
      (entry.steam_id64 !== null ? playerBySteam.get(entry.steam_id64) : undefined) ??
      (entry.eos_id !== null ? playerByEos.get(entry.eos_id) : undefined);
    if (!playerId) continue;
    result.set(playerId, {
      team: entry.team_id,
      squadName: entry.squad_id === null ? null : String(entry.squad_id),
    });
  }
  return result;
}

async function loadSessions(
  db: DatabaseClient,
  serverId: string,
  matchStart: Date,
  matchEnd: Date,
): Promise<SessionInterval[]> {
  return db
    .select({
      playerId: playerSessions.playerId,
      connectedAt: playerSessions.connectedAt,
      disconnectedAt: playerSessions.disconnectedAt,
    })
    .from(playerSessions)
    .where(
      and(
        eq(playerSessions.serverId, serverId),
        lt(playerSessions.connectedAt, matchEnd),
        or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, matchStart)),
      ),
    );
}

interface ClosedMatch {
  id: string;
  serverId: string;
  startedAt: Date;
  endedAt: Date;
}

async function loadClosedMatch(
  db: DatabaseClient,
  command: Extract<MatchCommand, { kind: 'close' | 'close_server_down' }>,
): Promise<ClosedMatch | null> {
  const rows =
    command.startedAt !== null
      ? await db
          .select({
            id: matches.id,
            serverId: matches.serverId,
            startedAt: matches.startedAt,
            endedAt: matches.endedAt,
          })
          .from(matches)
          .where(
            and(
              eq(matches.serverId, command.serverId),
              eq(matches.startedAt, new Date(command.startedAt)),
            ),
          )
          .limit(1)
      : await db
          .select({
            id: matches.id,
            serverId: matches.serverId,
            startedAt: matches.startedAt,
            endedAt: matches.endedAt,
          })
          .from(matches)
          .where(eq(matches.serverId, command.serverId))
          .orderBy(desc(matches.startedAt))
          .limit(1);

  const row = rows[0];
  if (!row || row.endedAt === null) return null;
  return { id: row.id, serverId: row.serverId, startedAt: row.startedAt, endedAt: row.endedAt };
}

export async function computeMatchRoster(
  db: DatabaseClient,
  params: { serverId: string; matchStart: Date; matchEnd: Date },
): Promise<MatchRosterEntry[]> {
  const [sessions, teamSquadByPlayer] = await Promise.all([
    loadSessions(db, params.serverId, params.matchStart, params.matchEnd),
    loadTeamSquadByPlayer(db, params.serverId, params.matchStart, params.matchEnd),
  ]);
  return assembleMatchRoster({
    matchStart: params.matchStart,
    matchEnd: params.matchEnd,
    sessions,
    teamSquadByPlayer,
  });
}

export async function computeOpenMatchRoster(
  db: DatabaseClient,
  params: { matchId: string; now: Date },
): Promise<MatchRosterEntry[]> {
  const rows = await db
    .select({
      serverId: matches.serverId,
      startedAt: matches.startedAt,
      endedAt: matches.endedAt,
    })
    .from(matches)
    .where(eq(matches.id, params.matchId))
    .limit(1);
  const match = rows[0];
  if (!match) return [];
  const matchEnd = match.endedAt ?? params.now;
  return computeMatchRoster(db, {
    serverId: match.serverId,
    matchStart: match.startedAt,
    matchEnd,
  });
}

export async function handleMatchClose(
  db: DatabaseClient,
  command: MatchCommand,
): Promise<{ written: number } | null> {
  if (command.kind !== 'close' && command.kind !== 'close_server_down') return null;

  const match = await loadClosedMatch(db, command);
  if (!match) return null;

  // The join-grace floor is what keeps ghost rounds out of the statistics.
  // Production opens two `matches` rows per round (#330) — a ~3 ms row carrying
  // the layer and the real round — and the ghost's window overlaps every open
  // session, so without this filter it collects a full roster of
  // `play_seconds = 0` rows and doubles `COUNT(DISTINCT matches.id)` in the
  // dossier. It also drops genuine connect-and-leaves, which is what
  // DEFAULT_JOIN_GRACE_SECONDS was defined for.
  const roster = filterRosterByPlaySeconds(
    await computeMatchRoster(db, {
      serverId: match.serverId,
      matchStart: match.startedAt,
      matchEnd: match.endedAt,
    }),
  );
  if (roster.length === 0) return { written: 0 };

  await db
    .insert(matchPlayers)
    .values(
      roster.map((entry) => ({
        matchId: match.id,
        playerId: entry.playerId,
        team: entry.team,
        squadName: entry.squadName,
        joinedAt: entry.joinedAt,
        leftAt: entry.leftAt,
        playSeconds: entry.playSeconds,
      })),
    )
    .onConflictDoUpdate({
      target: [matchPlayers.matchId, matchPlayers.playerId],
      set: {
        team: sqlExcluded('team'),
        squadName: sqlExcluded('squad_name'),
        joinedAt: sqlExcluded('joined_at'),
        leftAt: sqlExcluded('left_at'),
        playSeconds: sqlExcluded('play_seconds'),
      },
    });

  const combatStats = await loadMatchCombatStats(db, {
    serverId: match.serverId,
    matchStart: match.startedAt,
    matchEnd: match.endedAt,
  });
  await applyMatchCombatStats(db, {
    matchId: match.id,
    playerIds: roster.map((entry) => entry.playerId),
    stats: combatStats,
  });

  return { written: roster.length };
}
