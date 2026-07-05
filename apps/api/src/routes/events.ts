import { events, playerNameHistory, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const EXPORT_MAX = 50_000;

const kindSchema = z.string().trim().min(1).max(64);
const orderSchema = z.enum(['asc', 'desc']);

const filterShape = {
  serverId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  kind: z.union([kindSchema, z.array(kindSchema)]).optional(),
  playerId: z.string().uuid().optional(),
  playerQuery: z.string().trim().min(1).max(128).optional(),
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

const actorJoin = sql`${players.id}::text = ${events.actorId}`;

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

function serializeEnvelope(row: EventFullRow) {
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
    payload: row.payload,
  };
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
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

function csvRow(row: EventFullRow): string {
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
    JSON.stringify(row.payload),
  ];
  return cells.map(csvCell).join(',');
}

const eventsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function resolvePlayerIds(query: string): Promise<string[]> {
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
    if (serverIds.length > 0) clauses.push(inArray(events.serverId, serverIds));

    const kinds = asArray(query.kind);
    if (kinds.length > 0) clauses.push(inArray(events.kind, kinds));

    if (query.dateFrom) clauses.push(gte(events.occurredAt, query.dateFrom));
    if (query.dateTo) clauses.push(lte(events.occurredAt, query.dateTo));

    if (query.playerId) {
      clauses.push(eq(events.actorId, query.playerId));
    } else if (query.playerQuery) {
      const playerIds = await resolvePlayerIds(query.playerQuery);
      if (playerIds.length === 0) return { clauses, empty: true };
      clauses.push(inArray(events.actorId, playerIds));
    }

    return { clauses, empty: false };
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
    { schema: { querystring: countQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { clauses, empty } = await buildFilters(req.query);
      if (empty) return { total: 0 };

      const rows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(events)
        .where(clauses.length > 0 ? and(...clauses) : undefined);
      return { total: rows[0]?.total ?? 0 };
    },
  );

  fast.get(
    '/api/v1/events/export',
    { schema: { querystring: exportQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) {
        reply.header('content-type', 'application/json; charset=utf-8');
        return denied;
      }

      const { clauses, empty } = await buildFilters(req.query);
      const rows = empty
        ? []
        : await fullSelection()
            .where(clauses.length > 0 ? and(...clauses) : undefined)
            .orderBy(desc(events.occurredAt), desc(events.eventId))
            .limit(EXPORT_MAX);

      const lines = [CSV_COLUMNS.join(','), ...rows.map(csvRow)];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="events-${stamp}.csv"`);
      return reply.send(body);
    },
  );

  fast.get(
    '/api/v1/events/:eventId',
    { schema: { params: eventIdParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const rows = await fullSelection().where(eq(events.eventId, req.params.eventId)).limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'event_not_found' };
      }
      return serializeEnvelope(row);
    },
  );
};

export default eventsRoutes;
