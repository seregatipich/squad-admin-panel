import { Readable } from 'node:stream';
import { COMBAT_EVENT_TYPES, combatEvents, players } from '@squad/db/schema';
import { and, desc, eq, gte, inArray, lte, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 100;
const EXPORT_MAX = 100_000;
const EXPORT_BATCH = 1_000;
const COUNT_TIMEOUT_MS = 1_500;

const typeEnum = z.enum(COMBAT_EVENT_TYPES);
const boolFlag = z.enum(['true', 'false']);

const filterShape = {
  type: z.union([typeEnum, z.array(typeEnum)]).optional(),
  serverId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  matchId: z.coerce.bigint().optional(),
  attackerPlayerId: z.string().uuid().optional(),
  victimPlayerId: z.string().uuid().optional(),
  playerId: z.string().uuid().optional(),
  attackerName: z.string().trim().min(1).max(128).optional(),
  victimName: z.string().trim().min(1).max(128).optional(),
  weapon: z.string().trim().min(1).max(128).optional(),
  teamkillsOnly: boolFlag.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

const filterSchema = z.object(filterShape);

const listQuery = filterSchema.extend({
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

const exportQuery = filterSchema.extend({ format: z.literal('csv').default('csv') });

type FilterQuery = z.infer<typeof filterSchema>;
type ListQuery = z.infer<typeof listQuery>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function encodeCursor(occurredAt: Date, id: bigint): string {
  return Buffer.from(`${occurredAt.toISOString()}~${id.toString()}`).toString('base64url');
}

function decodeCursor(raw: string): { occurredAt: Date; id: bigint } | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('~');
    if (sep < 0) return null;
    const occurredAt = new Date(decoded.slice(0, sep));
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id: BigInt(decoded.slice(sep + 1)) };
  } catch {
    return null;
  }
}

function combatGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.combatView) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function hasActiveFilters(query: FilterQuery): boolean {
  return (
    asArray(query.type).length > 0 ||
    asArray(query.serverId).length > 0 ||
    query.matchId !== undefined ||
    query.attackerPlayerId !== undefined ||
    query.victimPlayerId !== undefined ||
    query.playerId !== undefined ||
    query.attackerName !== undefined ||
    query.victimName !== undefined ||
    query.weapon !== undefined ||
    query.teamkillsOnly === 'true' ||
    query.from !== undefined ||
    query.to !== undefined
  );
}

const combatEventsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const attacker = alias(players, 'attacker');
  const victim = alias(players, 'victim');

  async function resolveNameIds(name: string): Promise<string[]> {
    const pattern = `%${escapeLike(name.toLowerCase())}%`;
    const rows = await app.db
      .select({ id: players.id })
      .from(players)
      .where(sql`${players.canonicalNameNormalized} LIKE ${pattern}`);
    return rows.map((row) => row.id);
  }

  async function buildFilters(query: FilterQuery): Promise<{ clauses: SQL[]; empty: boolean }> {
    const clauses: SQL[] = [];

    const types = asArray(query.type);
    if (types.length > 0) clauses.push(inArray(combatEvents.eventType, types));

    const serverIds = asArray(query.serverId);
    if (serverIds.length > 0) clauses.push(inArray(combatEvents.serverId, serverIds));

    if (query.matchId !== undefined) clauses.push(eq(combatEvents.matchId, query.matchId));
    if (query.attackerPlayerId)
      clauses.push(eq(combatEvents.attackerPlayerId, query.attackerPlayerId));
    if (query.victimPlayerId) clauses.push(eq(combatEvents.victimPlayerId, query.victimPlayerId));

    if (query.playerId) {
      const playerMatch = or(
        eq(combatEvents.attackerPlayerId, query.playerId),
        eq(combatEvents.victimPlayerId, query.playerId),
      );
      if (playerMatch) clauses.push(playerMatch);
    }

    if (query.attackerName) {
      const ids = await resolveNameIds(query.attackerName);
      if (ids.length === 0) return { clauses, empty: true };
      clauses.push(inArray(combatEvents.attackerPlayerId, ids));
    }

    if (query.victimName) {
      const ids = await resolveNameIds(query.victimName);
      if (ids.length === 0) return { clauses, empty: true };
      clauses.push(inArray(combatEvents.victimPlayerId, ids));
    }

    if (query.weapon) {
      const pattern = `%${escapeLike(query.weapon)}%`;
      clauses.push(sql`${combatEvents.weapon} ILIKE ${pattern}`);
    }

    if (query.teamkillsOnly === 'true') clauses.push(eq(combatEvents.isTeamkill, true));
    if (query.from) clauses.push(gte(combatEvents.occurredAt, query.from));
    if (query.to) clauses.push(lte(combatEvents.occurredAt, query.to));

    return { clauses, empty: false };
  }

  async function estimateTotal(): Promise<number> {
    const rows = await app.db.execute<{ est: string }>(sql`
      SELECT GREATEST(COALESCE(SUM(c.reltuples), 0), 0)::bigint AS est
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'combat_events'::regclass
    `);
    const first = (rows as unknown as { est: string }[])[0];
    return first ? Number(first.est) : 0;
  }

  async function approxTotal(query: FilterQuery, where: SQL | undefined): Promise<number> {
    if (!hasActiveFilters(query)) return estimateTotal();
    try {
      return await app.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${COUNT_TIMEOUT_MS}`));
        const rows = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(combatEvents)
          .where(where);
        return rows[0]?.total ?? 0;
      });
    } catch {
      return estimateTotal();
    }
  }

  fast.get(
    '/api/v1/combat-events',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = combatGuard(req, reply);
      if (denied) return denied;

      const query: ListQuery = req.query;
      const { clauses, empty } = await buildFilters(query);
      if (empty) return { rows: [], nextCursor: null, approxTotal: 0 };

      const baseWhere = clauses.length > 0 ? and(...clauses) : undefined;

      const pageClauses = [...clauses];
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const cursorAt = cursor.occurredAt.toISOString();
        const cursorId = cursor.id.toString();
        pageClauses.push(
          sql`(${combatEvents.occurredAt} < ${cursorAt}::timestamptz OR (${combatEvents.occurredAt} = ${cursorAt}::timestamptz AND ${combatEvents.id} < ${cursorId}::bigint))`,
        );
      }

      const pageWhere = pageClauses.length > 0 ? and(...pageClauses) : undefined;
      const rows = await app.db
        .select({
          id: combatEvents.id,
          eventType: combatEvents.eventType,
          serverId: combatEvents.serverId,
          matchId: combatEvents.matchId,
          weapon: combatEvents.weapon,
          damage: combatEvents.damage,
          attackerKit: combatEvents.attackerKit,
          isTeamkill: combatEvents.isTeamkill,
          occurredAt: combatEvents.occurredAt,
          attackerId: combatEvents.attackerPlayerId,
          attackerName: attacker.canonicalName,
          victimId: combatEvents.victimPlayerId,
          victimName: victim.canonicalName,
        })
        .from(combatEvents)
        .leftJoin(attacker, eq(attacker.id, combatEvents.attackerPlayerId))
        .innerJoin(victim, eq(victim.id, combatEvents.victimPlayerId))
        .where(pageWhere)
        .orderBy(desc(combatEvents.occurredAt), desc(combatEvents.id))
        .limit(query.limit);

      const last = rows.length === query.limit ? rows[rows.length - 1] : null;
      return {
        rows: rows.map((row) => ({
          id: Number(row.id),
          eventType: row.eventType,
          serverId: row.serverId,
          matchId: row.matchId != null ? Number(row.matchId) : null,
          weapon: row.weapon,
          damage: row.damage,
          attackerKit: row.attackerKit,
          isTeamkill: row.isTeamkill,
          occurredAt: row.occurredAt.toISOString(),
          attacker: row.attackerId
            ? { player_id: row.attackerId, current_name: row.attackerName }
            : null,
          victim: { player_id: row.victimId, current_name: row.victimName },
        })),
        nextCursor: last ? encodeCursor(last.occurredAt, last.id) : null,
        approxTotal: await approxTotal(query, baseWhere),
      };
    },
  );

  fast.get(
    '/api/v1/combat-events/export',
    { schema: { querystring: exportQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = combatGuard(req, reply);
      if (denied) {
        reply.header('content-type', 'application/json; charset=utf-8');
        return denied;
      }

      const { clauses, empty } = await buildFilters(req.query);
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="combat-events-${stamp}.csv"`);

      const db = app.db;
      const stream = Readable.from(csvRows(db, clauses, empty), { objectMode: false });
      return reply.send(stream);
    },
  );

  async function* csvRows(
    db: typeof app.db,
    baseClauses: SQL[],
    empty: boolean,
  ): AsyncGenerator<string> {
    yield `${CSV_COLUMNS.join(',')}\r\n`;
    if (empty) return;

    let cursor: { occurredAt: Date; id: bigint } | null = null;
    let remaining = EXPORT_MAX;

    while (remaining > 0) {
      const batchSize = Math.min(EXPORT_BATCH, remaining);
      const pageClauses = [...baseClauses];
      if (cursor) {
        const cursorAt = cursor.occurredAt.toISOString();
        const cursorId = cursor.id.toString();
        pageClauses.push(
          sql`(${combatEvents.occurredAt} < ${cursorAt}::timestamptz OR (${combatEvents.occurredAt} = ${cursorAt}::timestamptz AND ${combatEvents.id} < ${cursorId}::bigint))`,
        );
      }
      const where = pageClauses.length > 0 ? and(...pageClauses) : undefined;
      const rows = await db
        .select({
          id: combatEvents.id,
          eventType: combatEvents.eventType,
          serverId: combatEvents.serverId,
          matchId: combatEvents.matchId,
          occurredAt: combatEvents.occurredAt,
          attackerId: combatEvents.attackerPlayerId,
          attackerName: attacker.canonicalName,
          victimId: combatEvents.victimPlayerId,
          victimName: victim.canonicalName,
          weapon: combatEvents.weapon,
          damage: combatEvents.damage,
          attackerKit: combatEvents.attackerKit,
          isTeamkill: combatEvents.isTeamkill,
        })
        .from(combatEvents)
        .leftJoin(attacker, eq(attacker.id, combatEvents.attackerPlayerId))
        .innerJoin(victim, eq(victim.id, combatEvents.victimPlayerId))
        .where(where)
        .orderBy(desc(combatEvents.occurredAt), desc(combatEvents.id))
        .limit(batchSize);

      const tail = rows.at(-1);
      if (!tail) break;

      let chunk = '';
      for (const row of rows) chunk += `${csvRow(row)}\r\n`;
      yield chunk;

      cursor = { occurredAt: tail.occurredAt, id: tail.id };
      remaining -= rows.length;
      if (rows.length < batchSize) break;
    }
  }
};

const CSV_COLUMNS = [
  'id',
  'event_type',
  'server_id',
  'match_id',
  'occurred_at',
  'attacker_player_id',
  'attacker_name',
  'victim_player_id',
  'victim_name',
  'weapon',
  'damage',
  'attacker_kit',
  'is_teamkill',
] as const;

interface CsvSourceRow {
  id: bigint;
  eventType: string;
  serverId: string;
  matchId: bigint | null;
  occurredAt: Date;
  attackerId: string | null;
  attackerName: string | null;
  victimId: string;
  victimName: string | null;
  weapon: string | null;
  damage: string | null;
  attackerKit: string | null;
  isTeamkill: boolean;
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(row: CsvSourceRow): string {
  const cells = [
    Number(row.id),
    row.eventType,
    row.serverId,
    row.matchId != null ? Number(row.matchId) : null,
    row.occurredAt.toISOString(),
    row.attackerId,
    row.attackerName,
    row.victimId,
    row.victimName,
    row.weapon,
    row.damage,
    row.attackerKit,
    row.isTeamkill,
  ];
  return cells.map(csvCell).join(',');
}

export default combatEventsRoutes;
