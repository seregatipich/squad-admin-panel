import { matches, matchPlayers, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const EXPORT_MAX = 10_000;
const LAYER_MAX = 200;

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

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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

interface Cursor {
  s: SortField;
  v: string | number | null;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function parseCursor(raw: string): Cursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as Cursor;
    if (!decoded || typeof decoded !== 'object') return null;
    if (!sortFieldSchema.safeParse(decoded.s).success) return null;
    if (typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)) return null;
    if (!(decoded.v === null || typeof decoded.v === 'string' || typeof decoded.v === 'number')) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function sortColumn(sort: SortField) {
  if (sort === 'duration_seconds') return matches.durationSeconds;
  if (sort === 'layer') return matches.layer;
  return matches.startedAt;
}

function cursorValueFor(sort: SortField, row: MatchListRow): string | number | null {
  if (sort === 'duration_seconds') return row.durationSeconds;
  if (sort === 'layer') return row.layer;
  return row.startedAt.getTime();
}

function comparableCursorValue(sort: SortField, value: string | number | null) {
  if (value === null) return null;
  if (sort === 'started_at') return new Date(value as number);
  return value;
}

function keysetPredicate(sort: SortField, order: OrderDir, cursor: Cursor): SQL {
  const column = sortColumn(sort);
  const beyond = order === 'desc' ? lt : gt;
  const value = comparableCursorValue(sort, cursor.v);
  if (value !== null) {
    return sql`(${beyond(column, value as never)} OR (${eq(column, value as never)} AND ${beyond(matches.id, cursor.id)}) OR ${column} IS NULL)`;
  }
  return sql`(${column} IS NULL AND ${beyond(matches.id, cursor.id)})`;
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

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
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
        clauses.push(keysetPredicate(sort, order, cursor));
      }

      const rows = await listSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(...orderByClause(sort, order))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({ s: sort, v: cursorValueFor(sort, last), id: last.id })
          : null;

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

      const rosterRows = await app.db
        .select({
          playerId: matchPlayers.playerId,
          nickname: players.canonicalName,
          team: matchPlayers.team,
          squadName: matchPlayers.squadName,
          playSeconds: matchPlayers.playSeconds,
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

      const roster = rosterRows.map((entry) => ({
        player_id: entry.playerId,
        nickname: entry.nickname,
        team: entry.team,
        squad_name: entry.squadName,
        play_seconds: entry.playSeconds,
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
      };
    },
  );
};

export default matchesRoutes;
