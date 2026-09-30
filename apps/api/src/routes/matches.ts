import { combatEvents, matches, matchPlayers, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvCell } from '../lib/csv.js';
import { panelGuard } from '../lib/panel-guard.js';
import { escapeLike } from '../lib/sql-like.js';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const EXPORT_MAX = 10_000;
const LAYER_MAX = 200;
const MATCH_TIMELINE_LIMIT = 30;
const MATCH_TIMELINE_TYPES = ['death', 'wound', 'revive', 'vehicle_destroyed'] as const;
// Squad server logs commonly emit a player's disconnect a few seconds before the
// round-end log line even for players who stayed the whole match; this tolerance
// absorbs that end-of-round jitter so those players are not misclassified as
// "left early".
const LEFT_EARLY_TOLERANCE_MS = 60_000;

const sortFieldSchema = z.enum(['started_at', 'duration_seconds', 'layer']);
const orderSchema = z.enum(['asc', 'desc']);
const winnerSchema = z.enum(['team1', 'team2', 'draw', 'null']);

type SortField = z.infer<typeof sortFieldSchema>;
type OrderDir = z.infer<typeof orderSchema>;

const toArray = (value: unknown): unknown =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

const filterShape = {
  serverIds: z.preprocess(toArray, z.array(z.string().uuid()).min(1).max(100).optional()),
  layer: z.string().trim().min(1).max(LAYER_MAX).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  hideSeeding: z.enum(['true', 'false']).default('true'),
  winner: winnerSchema.optional(),
  playerId: z.string().uuid().optional(),
};

const listQuery = z.object({
  ...filterShape,
  sort: sortFieldSchema.default('started_at'),
  order: orderSchema.default('desc'),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
});

const countQuery = z.object(filterShape);
const exportQuery = z.object({ ...filterShape, format: z.literal('csv').default('csv') });
const idParam = z.object({ id: z.string().uuid() });

type FilterInput = z.infer<typeof countQuery>;

const STAT_KEYS = ['kills', 'deaths', 'teamkills', 'wounds', 'revives'] as const;
type StatKey = (typeof STAT_KEYS)[number];

function buildFilters(query: FilterInput): SQL[] {
  const clauses: SQL[] = [];
  if (query.serverIds && query.serverIds.length > 0) {
    clauses.push(inArray(matches.serverId, query.serverIds));
  }
  if (query.layer) {
    clauses.push(sql`${matches.layer} ILIKE ${`%${escapeLike(query.layer)}%`} ESCAPE '\\'`);
  }
  if (query.dateFrom) clauses.push(gte(matches.startedAt, query.dateFrom));
  if (query.dateTo) clauses.push(lte(matches.startedAt, query.dateTo));
  if (query.hideSeeding !== 'false') clauses.push(eq(matches.isSeed, false));
  if (query.winner === 'null') clauses.push(isNull(matches.winner));
  else if (query.winner) clauses.push(eq(matches.winner, query.winner));
  if (query.playerId) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM ${matchPlayers} WHERE ${matchPlayers.matchId} = ${matches.id} AND ${matchPlayers.playerId} = ${query.playerId})`,
    );
  }
  return clauses;
}

const cursorId = z.string().regex(/^[0-9a-f-]{36}$/i);
/** Largest epoch-ms value a JS `Date` can hold (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;
const PG_INT_MIN = -2_147_483_648;
const PG_INT_MAX = 2_147_483_647;

/**
 * Keyset cursor, validated per sort field so a forged cursor is a 400
 * `invalid_cursor`, never an Invalid Date or a type error inside Postgres.
 * `started_at` is NOT NULL and travels as epoch milliseconds; the other two
 * sort columns are nullable.
 */
const cursorSchema = z.discriminatedUnion('s', [
  z.object({
    s: z.literal('started_at'),
    v: z.number().int().min(0).max(MAX_DATE_MS),
    id: cursorId,
  }),
  z.object({
    s: z.literal('duration_seconds'),
    v: z.number().int().min(PG_INT_MIN).max(PG_INT_MAX).nullable(),
    id: cursorId,
  }),
  z.object({ s: z.literal('layer'), v: z.string().max(LAYER_MAX).nullable(), id: cursorId }),
]);

type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function parseCursor(raw: string): Cursor | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

function sortColumn(sort: SortField) {
  if (sort === 'duration_seconds') return matches.durationSeconds;
  if (sort === 'layer') return matches.layer;
  return matches.startedAt;
}

function cursorFor(sort: SortField, row: MatchListRow): Cursor {
  if (sort === 'duration_seconds') return { s: sort, v: row.durationSeconds, id: row.id };
  if (sort === 'layer') return { s: sort, v: row.layer, id: row.id };
  return { s: sort, v: row.startedAt.getTime(), id: row.id };
}

/**
 * Rows strictly after `cursor` in `(column, id)` order, with NULL sort values
 * last (matching {@link orderByClause}'s `NULLS LAST`).
 */
function keysetPredicate(order: OrderDir, cursor: Cursor): SQL {
  const beyond = order === 'desc' ? lt : gt;
  const tieOrBeyond = (column: SQL, sameValue: SQL): SQL =>
    sql`(${column} OR (${sameValue} AND ${beyond(matches.id, cursor.id)}))`;
  switch (cursor.s) {
    case 'started_at': {
      const value = new Date(cursor.v);
      return tieOrBeyond(beyond(matches.startedAt, value), eq(matches.startedAt, value));
    }
    case 'duration_seconds': {
      const column = matches.durationSeconds;
      if (cursor.v === null) return sql`(${column} IS NULL AND ${beyond(matches.id, cursor.id)})`;
      return sql`(${tieOrBeyond(beyond(column, cursor.v), eq(column, cursor.v))} OR ${column} IS NULL)`;
    }
    case 'layer': {
      const column = matches.layer;
      if (cursor.v === null) return sql`(${column} IS NULL AND ${beyond(matches.id, cursor.id)})`;
      return sql`(${tieOrBeyond(beyond(column, cursor.v), eq(column, cursor.v))} OR ${column} IS NULL)`;
    }
  }
}

function orderByClause(sort: SortField, order: OrderDir): SQL[] {
  const column = sortColumn(sort);
  const primary = order === 'desc' ? sql`${column} DESC NULLS LAST` : sql`${column} ASC NULLS LAST`;
  const tiebreak = order === 'desc' ? desc(matches.id) : asc(matches.id);
  return [primary, tiebreak];
}

interface MatchListRow {
  id: string;
  serverId: string;
  serverName: string | null;
  serverSlug: string | null;
  layer: string | null;
  map: string | null;
  gameMode: string | null;
  team1Faction: string | null;
  team2Faction: string | null;
  team1Tickets: number | null;
  team2Tickets: number | null;
  winner: string | null;
  isSeed: boolean;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  endReason: string | null;
}

function serializeMatch(row: MatchListRow) {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    layer: row.layer,
    map: row.map,
    game_mode: row.gameMode,
    team1_faction: row.team1Faction,
    team2_faction: row.team2Faction,
    team1_tickets: row.team1Tickets,
    team2_tickets: row.team2Tickets,
    winner: row.winner,
    is_seed: row.isSeed,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    duration_seconds: row.durationSeconds,
    end_reason: row.endReason,
  };
}

function serializeAdjacentMatch(row: MatchListRow | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    layer: row.layer,
    started_at: row.startedAt.toISOString(),
  };
}

/**
 * Determines whether a roster entry left the match before it ended.
 *
 * A player who never disconnected (`leftAt === null`) is never flagged.
 * A player who left an open match (`endedAt === null`) is always flagged,
 * since any disconnect before the match has ended is an early departure.
 * Otherwise a player is flagged only if they left more than
 * {@link LEFT_EARLY_TOLERANCE_MS} before the match ended, to absorb the
 * disconnect/round-end log jitter that affects players who stayed the whole match.
 */
function isLeftEarly(leftAt: Date | null, endedAt: Date | null): boolean {
  if (leftAt === null) return false;
  if (endedAt === null) return true;
  return endedAt.getTime() - leftAt.getTime() > LEFT_EARLY_TOLERANCE_MS;
}

interface MatchTimelineRow {
  id: bigint;
  eventType: string;
  occurredAt: Date;
  weapon: string | null;
  damage: string | null;
  attackerKit: string | null;
  victimVehicle: string | null;
  attackerVehicle: string | null;
  isTeamkill: boolean;
  attackerId: string | null;
  attackerName: string | null;
  victimId: string | null;
  victimName: string | null;
}

function serializeTimelineEvent(row: MatchTimelineRow) {
  return {
    id: Number(row.id),
    event_type: row.eventType,
    occurred_at: row.occurredAt.toISOString(),
    weapon: row.weapon,
    damage: row.damage,
    attacker_kit: row.attackerKit,
    victim_vehicle: row.victimVehicle,
    attacker_vehicle: row.attackerVehicle,
    is_teamkill: row.isTeamkill,
    attacker: row.attackerId ? { player_id: row.attackerId, current_name: row.attackerName } : null,
    victim: row.victimId ? { player_id: row.victimId, current_name: row.victimName } : null,
  };
}

function sumNullableStat(rows: Array<Record<StatKey, number | null>>, key: StatKey): number | null {
  let total = 0;
  let hasValue = false;
  for (const row of rows) {
    const value = row[key];
    if (value === null) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

const CSV_COLUMNS = [
  'id',
  'server_id',
  'server_name',
  'layer',
  'map',
  'game_mode',
  'team1_faction',
  'team2_faction',
  'team1_tickets',
  'team2_tickets',
  'winner',
  'is_seed',
  'started_at',
  'ended_at',
  'duration_seconds',
  'end_reason',
] as const;

function csvRow(row: MatchListRow): string {
  const cells = [
    row.id,
    row.serverId,
    row.serverName,
    row.layer,
    row.map,
    row.gameMode,
    row.team1Faction,
    row.team2Faction,
    row.team1Tickets,
    row.team2Tickets,
    row.winner,
    row.isSeed,
    row.startedAt.toISOString(),
    row.endedAt ? row.endedAt.toISOString() : null,
    row.durationSeconds,
    row.endReason,
  ];
  return cells.map(csvCell).join(',');
}

const matchesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const combatAttacker = alias(players, 'match_combat_attacker');
  const combatVictim = alias(players, 'match_combat_victim');

  function listSelection() {
    return app.db
      .select({
        id: matches.id,
        serverId: matches.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        layer: matches.layer,
        map: matches.map,
        gameMode: matches.gameMode,
        team1Faction: matches.team1Faction,
        team2Faction: matches.team2Faction,
        team1Tickets: matches.team1Tickets,
        team2Tickets: matches.team2Tickets,
        winner: matches.winner,
        isSeed: matches.isSeed,
        startedAt: matches.startedAt,
        endedAt: matches.endedAt,
        durationSeconds: matches.durationSeconds,
        endReason: matches.endReason,
      })
      .from(matches)
      .leftJoin(servers, eq(servers.id, matches.serverId));
  }

  fast.get(
    '/api/v1/matches',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { sort, order, limit } = req.query;
      const clauses = buildFilters(req.query);

      if (req.query.cursor) {
        const cursor = parseCursor(req.query.cursor);
        if (!cursor || cursor.s !== sort) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        clauses.push(keysetPredicate(order, cursor));
      }

      const rows = await listSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(...orderByClause(sort, order))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(cursorFor(sort, last)) : null;

      return {
        items: page.map(serializeMatch),
        next_cursor: nextCursor,
        limit,
      };
    },
  );

  fast.get(
    '/api/v1/matches/count',
    { schema: { querystring: countQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const clauses = buildFilters(req.query);
      const rows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(matches)
        .where(clauses.length > 0 ? and(...clauses) : undefined);
      return { total: rows[0]?.total ?? 0 };
    },
  );

  fast.get(
    '/api/v1/matches/export',
    { schema: { querystring: exportQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) {
        reply.header('content-type', 'application/json; charset=utf-8');
        return denied;
      }

      const clauses = buildFilters(req.query);
      const rows = await listSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(EXPORT_MAX);

      const lines = [CSV_COLUMNS.join(','), ...rows.map(csvRow)];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="matches-${stamp}.csv"`);
      return reply.send(body);
    },
  );

  fast.get(
    '/api/v1/matches/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const matchRows = await listSelection().where(eq(matches.id, req.params.id)).limit(1);
      const match = matchRows[0];
      if (!match) {
        reply.code(404);
        return { error: 'match_not_found' };
      }
      const canViewCombat = req.user?.permissions.combatView === true;

      const rosterRows = await app.db
        .select({
          playerId: matchPlayers.playerId,
          nickname: players.canonicalName,
          team: matchPlayers.team,
          squadName: matchPlayers.squadName,
          playSeconds: matchPlayers.playSeconds,
          leftAt: matchPlayers.leftAt,
          kills: matchPlayers.kills,
          deaths: matchPlayers.deaths,
          teamkills: matchPlayers.teamkills,
          wounds: matchPlayers.wounds,
          revives: matchPlayers.revives,
        })
        .from(matchPlayers)
        .innerJoin(players, eq(players.id, matchPlayers.playerId))
        .where(eq(matchPlayers.matchId, match.id))
        .orderBy(asc(matchPlayers.team), desc(matchPlayers.playSeconds));

      const [previousRows, nextRows] = await Promise.all([
        listSelection()
          .where(and(eq(matches.serverId, match.serverId), lt(matches.startedAt, match.startedAt)))
          .orderBy(desc(matches.startedAt), desc(matches.id))
          .limit(1),
        listSelection()
          .where(and(eq(matches.serverId, match.serverId), gt(matches.startedAt, match.startedAt)))
          .orderBy(asc(matches.startedAt), asc(matches.id))
          .limit(1),
      ]);

      const timelineRows = canViewCombat
        ? await app.db
            .select({
              id: combatEvents.id,
              eventType: combatEvents.eventType,
              occurredAt: combatEvents.occurredAt,
              weapon: combatEvents.weapon,
              damage: combatEvents.damage,
              attackerKit: combatEvents.attackerKit,
              victimVehicle: combatEvents.victimVehicle,
              attackerVehicle: combatEvents.attackerVehicle,
              isTeamkill: combatEvents.isTeamkill,
              attackerId: combatEvents.attackerPlayerId,
              attackerName: combatAttacker.canonicalName,
              victimId: combatEvents.victimPlayerId,
              victimName: combatVictim.canonicalName,
            })
            .from(combatEvents)
            .leftJoin(combatAttacker, eq(combatAttacker.id, combatEvents.attackerPlayerId))
            .leftJoin(combatVictim, eq(combatVictim.id, combatEvents.victimPlayerId))
            .where(
              and(
                eq(combatEvents.serverId, match.serverId),
                inArray(combatEvents.eventType, [...MATCH_TIMELINE_TYPES]),
                gte(combatEvents.occurredAt, match.startedAt),
                lte(combatEvents.occurredAt, match.endedAt ?? new Date()),
              ),
            )
            .orderBy(desc(combatEvents.occurredAt), desc(combatEvents.id))
            .limit(MATCH_TIMELINE_LIMIT)
        : null;

      const roster = rosterRows.map((entry) => ({
        player_id: entry.playerId,
        nickname: entry.nickname,
        team: entry.team,
        squad_name: entry.squadName,
        play_seconds: entry.playSeconds,
        left_at: entry.leftAt ? entry.leftAt.toISOString() : null,
        left_early: isLeftEarly(entry.leftAt, match.endedAt),
        kills: entry.kills,
        deaths: entry.deaths,
        teamkills: entry.teamkills,
        wounds: entry.wounds,
        revives: entry.revives,
      }));

      const teamAggregate = (team: 1 | 2) => {
        const members = rosterRows.filter((entry) => entry.team === team);
        return {
          players: members.length,
          play_seconds: members.reduce((sum, entry) => sum + entry.playSeconds, 0),
          ...Object.fromEntries(STAT_KEYS.map((key) => [key, sumNullableStat(members, key)])),
        };
      };

      return {
        ...serializeMatch(match),
        roster,
        teams: { team1: teamAggregate(1), team2: teamAggregate(2) },
        previous_match: serializeAdjacentMatch(previousRows[0]),
        next_match: serializeAdjacentMatch(nextRows[0]),
        combat_events: timelineRows ? timelineRows.map(serializeTimelineEvent) : null,
      };
    },
  );
};

export default matchesRoutes;
