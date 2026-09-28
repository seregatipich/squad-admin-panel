import { Readable } from 'node:stream';
import { events, playerNameHistory, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvCell } from '../lib/csv.js';
import { canViewIps, redactPayloadIp } from '../lib/ip-visibility.js';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const EXPORT_MAX = 50_000;
/** Rows fetched per keyset page while streaming the CSV export. */
const EXPORT_BATCH = 1_000;
/**
 * Above this planner estimate an unfiltered `/events/count` answers with the
 * estimate instead of counting every partition row by row.
 */
const COUNT_ESTIMATE_MIN_ROWS = 100_000;

const kindSchema = z.string().trim().min(1).max(64);
const orderSchema = z.enum(['asc', 'desc']);

const filterShape = {
  serverId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  kind: z.union([kindSchema, z.array(kindSchema)]).optional(),
  playerId: z.string().uuid().optional(),
  playerQuery: z.string().trim().min(1).max(128).optional(),
  ruleId: z.string().uuid().optional(),
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
const exportQuery = z.object({ ...filterShape, format: z.literal('csv').default('csv') });
const eventIdParam = z.object({ eventId: z.string().uuid() });

type FilterInput = z.infer<typeof countQuery>;
type OrderDir = z.infer<typeof orderSchema>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface Cursor {
  occurredAt: Date;
  eventId: string;
}

function encodeCursor(occurredAt: Date, eventId: string): string {
  return Buffer.from(`${occurredAt.toISOString()}~${eventId}`, 'utf-8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    const sep = decoded.lastIndexOf('~');
    if (sep < 0) return null;
    const occurredAt = new Date(decoded.slice(0, sep));
    const eventId = decoded.slice(sep + 1);
    if (Number.isNaN(occurredAt.getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
    return { occurredAt, eventId };
  } catch {
    return null;
  }
}

// `events.actor_id` is free text (a player uuid, or a label such as a worker
// name). Casting only well-formed uuids — instead of casting `players.id` to
// text — keeps the players primary key usable for the join.
const actorJoin = sql`${players.id} = CASE WHEN ${events.actorId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${events.actorId}::uuid END`;

/**
 * Matches events whose actor has — or once had — a nickname containing
 * `query`. Kept as a subquery (served by the pg_trgm indexes on both nickname
 * columns) rather than a materialised id list, so a one-letter search cannot
 * expand into an unbounded `IN (…)` of bind parameters.
 */
function actorNicknameMatches(query: string): SQL {
  const pattern = `%${escapeLike(query.trim().toLowerCase())}%`;
  return sql`${events.actorId} IN (
    SELECT ${players.id}::text FROM ${players}
    WHERE ${players.canonicalNameNormalized} LIKE ${pattern}
    UNION
    SELECT ${playerNameHistory.playerId}::text FROM ${playerNameHistory}
    WHERE ${playerNameHistory.nameNormalized} LIKE ${pattern}
  )`;
}

interface EventListRow {
  eventId: string;
  serverId: string | null;
  serverName: string | null;
  serverSlug: string | null;
  occurredAt: Date;
  kind: string;
  version: number;
  actorKind: string | null;
  actorId: string | null;
  actorNickname: string | null;
  correlationId: string | null;
}

interface EventFullRow extends EventListRow {
  payload: unknown;
}

function serializeEvent(row: EventListRow) {
  return {
    event_id: row.eventId,
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    occurred_at: row.occurredAt.toISOString(),
    kind: row.kind,
    version: row.version,
    actor_kind: row.actorKind,
    actor_id: row.actorId,
    actor_nickname: row.actorNickname,
    correlation_id: row.correlationId,
  };
}

function serializeEnvelope(row: EventFullRow, includeIps: boolean) {
  const actor = row.actorKind || row.actorId ? { kind: row.actorKind, id: row.actorId } : null;
  return {
    event_id: row.eventId,
    version: row.version,
    type: row.kind,
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    ts: row.occurredAt.toISOString(),
    actor,
    actor_nickname: row.actorNickname,
    correlation_id: row.correlationId,
    payload: includeIps ? row.payload : redactPayloadIp(row.payload),
  };
}

const CSV_COLUMNS = [
  'event_id',
  'server_id',
  'server_name',
  'occurred_at',
  'kind',
  'version',
  'actor_kind',
  'actor_id',
  'actor_nickname',
  'correlation_id',
  'payload',
] as const;

function csvRow(row: EventFullRow, includeIps: boolean): string {
  const cells = [
    row.eventId,
    row.serverId,
    row.serverName,
    row.occurredAt.toISOString(),
    row.kind,
    row.version,
    row.actorKind,
    row.actorId,
    row.actorNickname,
    row.correlationId,
    JSON.stringify(includeIps ? row.payload : redactPayloadIp(row.payload)),
  ];
  return cells.map(csvCell).join(',');
}

const eventsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  function buildFilters(query: FilterInput): SQL[] {
    const clauses: SQL[] = [];

    const serverIds = asArray(query.serverId);
    if (serverIds.length > 0) clauses.push(inArray(events.serverId, serverIds));

    const kinds = asArray(query.kind);
    if (kinds.length > 0) clauses.push(inArray(events.kind, kinds));

    if (query.dateFrom) clauses.push(gte(events.occurredAt, query.dateFrom));
    if (query.dateTo) clauses.push(lte(events.occurredAt, query.dateTo));

    if (query.playerId) {
      clauses.push(eq(events.actorId, query.playerId));
    } else if (query.playerQuery) {
      clauses.push(actorNicknameMatches(query.playerQuery));
    }

    // BANNAME-3: lets /banned-names link a rule's row to «its» events (e.g.
    // banname.matched hits), filtering on the rule_id carried in the event
    // payload rather than a dedicated column.
    if (query.ruleId) {
      clauses.push(sql`(${events.payload} ->> 'rule_id') = ${query.ruleId}`);
    }

    return clauses;
  }

  /** Sum of the planner's row estimates over every `events` partition. */
  async function estimatedEventCount(): Promise<number> {
    const rows = (await app.db.execute(sql`
      SELECT coalesce(sum(c.reltuples) FILTER (WHERE c.reltuples > 0), 0)::bigint AS estimate
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'events'::regclass
    `)) as unknown as Array<{ estimate: string | number }>;
    return Number(rows[0]?.estimate ?? 0);
  }

  function listSelection() {
    return app.db
      .select({
        eventId: events.eventId,
        serverId: events.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        occurredAt: events.occurredAt,
        kind: events.kind,
        version: events.version,
        actorKind: events.actorKind,
        actorId: events.actorId,
        actorNickname: players.canonicalName,
        correlationId: events.correlationId,
      })
      .from(events)
      .leftJoin(servers, eq(servers.id, events.serverId))
      .leftJoin(players, actorJoin);
  }

  function fullSelection() {
    return app.db
      .select({
        eventId: events.eventId,
        serverId: events.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        occurredAt: events.occurredAt,
        kind: events.kind,
        version: events.version,
        actorKind: events.actorKind,
        actorId: events.actorId,
        actorNickname: players.canonicalName,
        correlationId: events.correlationId,
        payload: events.payload,
      })
      .from(events)
      .leftJoin(servers, eq(servers.id, events.serverId))
      .leftJoin(players, actorJoin);
  }

  function keysetPredicate(order: OrderDir, cursor: Cursor): SQL {
    const stamp = cursor.occurredAt.toISOString();
    if (order === 'desc') {
      return sql`(${events.occurredAt} < ${stamp}::timestamptz OR (${events.occurredAt} = ${stamp}::timestamptz AND ${events.eventId} < ${cursor.eventId}::uuid))`;
    }
    return sql`(${events.occurredAt} > ${stamp}::timestamptz OR (${events.occurredAt} = ${stamp}::timestamptz AND ${events.eventId} > ${cursor.eventId}::uuid))`;
  }

  fast.get(
    '/api/v1/events',
    { schema: { querystring: listQuery }, config: { permissions: ['events:view'], audit: false } },
    async (req, reply) => {
      const { order, limit } = req.query;
      const clauses = buildFilters(req.query);

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
          ? [desc(events.occurredAt), desc(events.eventId)]
          : [asc(events.occurredAt), asc(events.eventId)];

      const rows = await listSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(...orderBy)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.eventId) : null;

      return {
        items: page.map(serializeEvent),
        next_cursor: nextCursor,
        limit,
      };
    },
  );

  fast.get(
    '/api/v1/events/count',
    { schema: { querystring: countQuery }, config: { permissions: ['events:view'], audit: false } },
    async (req) => {
      const clauses = buildFilters(req.query);
      if (clauses.length === 0) {
        // The unfiltered journal spans every partition; an exact count(*) of
        // it is a full scan on each filter change, so a large table answers
        // with the planner's estimate and says so.
        const estimate = await estimatedEventCount();
        if (estimate >= COUNT_ESTIMATE_MIN_ROWS) return { total: estimate, estimated: true };
      }

      const rows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(events)
        .where(clauses.length > 0 ? and(...clauses) : undefined);
      return { total: rows[0]?.total ?? 0, estimated: false };
    },
  );

  fast.get(
    '/api/v1/events/export',
    {
      schema: { querystring: exportQuery },
      config: { permissions: ['events:view'], audit: false },
    },
    async (req, reply) => {
      const clauses = buildFilters(req.query);
      const includeIps = canViewIps(req);
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="events-${stamp}.csv"`);
      return reply.send(Readable.from(csvLines(clauses, includeIps), { objectMode: false }));
    },
  );

  /**
   * Streams the export newest first in keyset pages of {@link EXPORT_BATCH}
   * rows, up to {@link EXPORT_MAX}, so the whole file (jsonb payloads
   * included) is never held in memory at once.
   */
  async function* csvLines(baseClauses: SQL[], includeIps: boolean): AsyncGenerator<string> {
    yield `${CSV_COLUMNS.join(',')}\r\n`;

    let cursor: Cursor | null = null;
    let remaining = EXPORT_MAX;
    while (remaining > 0) {
      const batchSize = Math.min(EXPORT_BATCH, remaining);
      const clauses: SQL[] = cursor
        ? [...baseClauses, keysetPredicate('desc', cursor)]
        : baseClauses;
      const rows = await fullSelection()
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(desc(events.occurredAt), desc(events.eventId))
        .limit(batchSize);
      if (rows.length === 0) break;

      yield rows.map((row) => `${csvRow(row, includeIps)}\r\n`).join('');

      const tail = rows.at(-1);
      if (!tail || rows.length < batchSize) break;
      cursor = { occurredAt: tail.occurredAt, eventId: tail.eventId };
      remaining -= rows.length;
    }
  }

  fast.get(
    '/api/v1/events/:eventId',
    { schema: { params: eventIdParam }, config: { permissions: ['events:view'], audit: false } },
    async (req, reply) => {
      const rows = await fullSelection().where(eq(events.eventId, req.params.eventId)).limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'event_not_found' };
      }
      return serializeEnvelope(row, canViewIps(req));
    },
  );
};

export default eventsRoutes;
