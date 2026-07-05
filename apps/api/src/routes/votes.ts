import { gameVoteBallots, gameVotes, playerNameHistory, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

const voteTypeEnum = z.enum(['map_skip', 'map_change', 'admin']);
const resultEnum = z.enum(['passed', 'failed', 'cancelled']);
const orderSchema = z.enum(['asc', 'desc']);

const filterShape = {
  serverId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  voteType: z.union([voteTypeEnum, z.array(voteTypeEnum)]).optional(),
  result: z.union([resultEnum, z.array(resultEnum)]).optional(),
  initiatorPlayerId: z.string().uuid().optional(),
  initiatorQuery: z.string().trim().min(1).max(128).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
};

const listQuery = z.object({
  ...filterShape,
  order: orderSchema.default('desc'),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
});

const countQuery = z.object(filterShape);
const idParam = z.object({ id: z.string().uuid() });

type FilterInput = z.infer<typeof countQuery>;
type OrderDir = z.infer<typeof orderSchema>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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

interface Cursor {
  startedAt: Date;
  id: string;
}

function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}~${id}`, 'utf-8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    const sep = decoded.lastIndexOf('~');
    if (sep < 0) return null;
    const startedAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(startedAt.getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

const ballotCountSql = sql<number>`(SELECT count(*)::int FROM ${gameVoteBallots} WHERE ${gameVoteBallots.voteId} = ${gameVotes.id})`;

interface VoteListRow {
  id: string;
  serverId: string;
  serverName: string | null;
  serverSlug: string | null;
  initiatorPlayerId: string | null;
  initiatorNickname: string | null;
  voteType: string;
  mapCurrent: string | null;
  mapNext: string | null;
  mapTarget: string | null;
  votesCollected: number;
  votesRequired: number;
  result: string | null;
  durationSeconds: number | null;
  startedAt: Date;
  endedAt: Date | null;
  ballotCount: number;
}

function serializeVote(row: VoteListRow) {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    initiator_player_id: row.initiatorPlayerId,
    initiator_nickname: row.initiatorNickname,
    vote_type: row.voteType,
    map_current: row.mapCurrent,
    map_next: row.mapNext,
    map_target: row.mapTarget,
    votes_collected: row.votesCollected,
    votes_required: row.votesRequired,
    result: row.result,
    duration_seconds: row.durationSeconds,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    ballot_count: row.ballotCount,
  };
}

const votesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function resolveInitiatorIds(query: string): Promise<string[]> {
    const ids = new Set<string>();
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const pattern = `%${escapeLike(normalized)}%`;

    const canonicalRows = await app.db
      .select({ id: players.id })
      .from(players)
      .where(sql`${players.canonicalNameNormalized} LIKE ${pattern}`);
    for (const row of canonicalRows) ids.add(row.id);

    const historyRows = await app.db
      .selectDistinct({ id: playerNameHistory.playerId })
      .from(playerNameHistory)
      .where(sql`${playerNameHistory.nameNormalized} LIKE ${pattern}`);
    for (const row of historyRows) ids.add(row.id);

    return Array.from(ids);
  }

  async function buildFilters(query: FilterInput): Promise<{ clauses: SQL[]; empty: boolean }> {
    const clauses: SQL[] = [];

    const serverIds = asArray(query.serverId);
    if (serverIds.length > 0) clauses.push(inArray(gameVotes.serverId, serverIds));

    const voteTypes = asArray(query.voteType);
    if (voteTypes.length > 0) clauses.push(inArray(gameVotes.voteType, voteTypes));

    const results = asArray(query.result);
    if (results.length > 0) clauses.push(inArray(gameVotes.result, results));

    if (query.dateFrom) clauses.push(gte(gameVotes.startedAt, query.dateFrom));
    if (query.dateTo) clauses.push(lte(gameVotes.startedAt, query.dateTo));

    if (query.initiatorPlayerId) {
      clauses.push(eq(gameVotes.initiatorPlayerId, query.initiatorPlayerId));
    } else if (query.initiatorQuery) {
      const initiatorIds = await resolveInitiatorIds(query.initiatorQuery);
      if (initiatorIds.length === 0) return { clauses, empty: true };
      clauses.push(inArray(gameVotes.initiatorPlayerId, initiatorIds));
    }

    return { clauses, empty: false };
  }

  function listSelection() {
    return app.db
      .select({
        id: gameVotes.id,
        serverId: gameVotes.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        initiatorPlayerId: gameVotes.initiatorPlayerId,
        initiatorNickname: players.canonicalName,
        voteType: gameVotes.voteType,
        mapCurrent: gameVotes.mapCurrent,
        mapNext: gameVotes.mapNext,
        mapTarget: gameVotes.mapTarget,
        votesCollected: gameVotes.votesCollected,
        votesRequired: gameVotes.votesRequired,
        result: gameVotes.result,
        durationSeconds: gameVotes.durationSeconds,
        startedAt: gameVotes.startedAt,
        endedAt: gameVotes.endedAt,
        ballotCount: ballotCountSql,
      })
      .from(gameVotes)
      .leftJoin(servers, eq(servers.id, gameVotes.serverId))
      .leftJoin(players, eq(players.id, gameVotes.initiatorPlayerId));
  }

  function keysetPredicate(order: OrderDir, cursor: Cursor): SQL {
    const stamp = cursor.startedAt.toISOString();
    if (order === 'desc') {
      return sql`(${gameVotes.startedAt} < ${stamp}::timestamptz OR (${gameVotes.startedAt} = ${stamp}::timestamptz AND ${gameVotes.id} < ${cursor.id}::uuid))`;
    }
    return sql`(${gameVotes.startedAt} > ${stamp}::timestamptz OR (${gameVotes.startedAt} = ${stamp}::timestamptz AND ${gameVotes.id} > ${cursor.id}::uuid))`;
  }

  fast.get(
    '/api/v1/votes',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { order, limit } = req.query;
      const { clauses, empty } = await buildFilters(req.query);
      if (empty) return { items: [], next_cursor: null, limit };

      if (req.query.cursor) {
        const cursor = decodeCursor(req.query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        clauses.push(keysetPredicate(order, cursor));
      }

      const orderBy =
        order === 'desc'
          ? [desc(gameVotes.startedAt), desc(gameVotes.id)]
          : [asc(gameVotes.startedAt), asc(gameVotes.id)];

      const rows = await listSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(...orderBy)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.startedAt, last.id) : null;

      return {
        items: page.map(serializeVote),
        next_cursor: nextCursor,
        limit,
      };
    },
  );

  fast.get(
    '/api/v1/votes/count',
    { schema: { querystring: countQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { clauses, empty } = await buildFilters(req.query);
      if (empty) return { total: 0 };

      const rows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(gameVotes)
        .where(clauses.length > 0 ? and(...clauses) : undefined);
      return { total: rows[0]?.total ?? 0 };
    },
  );

  fast.get(
    '/api/v1/votes/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const voteRows = await listSelection().where(eq(gameVotes.id, req.params.id)).limit(1);
      const vote = voteRows[0];
      if (!vote) {
        reply.code(404);
        return { error: 'vote_not_found' };
      }

      const ballotRows = await app.db
        .select({
          playerId: gameVoteBallots.playerId,
          nickname: players.canonicalName,
          choice: gameVoteBallots.choice,
          votedAt: gameVoteBallots.votedAt,
        })
        .from(gameVoteBallots)
        .innerJoin(players, eq(players.id, gameVoteBallots.playerId))
        .where(eq(gameVoteBallots.voteId, vote.id))
        .orderBy(asc(gameVoteBallots.votedAt), asc(gameVoteBallots.playerId));

      const ballots = ballotRows.map((entry) => ({
        player_id: entry.playerId,
        nickname: entry.nickname,
        choice: entry.choice,
        voted_at: entry.votedAt.toISOString(),
      }));

      return { ...serializeVote(vote), ballots };
    },
  );
};

export default votesRoutes;
