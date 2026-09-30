import { CHAT_SCOPES, CHAT_SOURCES, chatMessages, players } from '@squad/db/schema';
import { and, desc, eq, gte, inArray, lte, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { playerNameMatch } from '../lib/player-name-search.js';
import { requestUser } from '../lib/request-user.js';

const LIMIT_MAX = 300;
const LIMIT_DEFAULT = 100;
/** A SteamID64 is always 17 digits, so it always fits Postgres int8 (#119). */
const STEAM_ID_RE = /^\d{17}$/;
/** Largest value of Postgres `bigint`; a cursor id past it would 500 in SQL. */
const INT8_MAX = 9_223_372_036_854_775_807n;

const scopeEnum = z.enum(CHAT_SCOPES);
const sourceEnum = z.enum(CHAT_SOURCES);
const boolFlag = z.enum(['true', 'false']);

const listQuery = z.object({
  serverId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  scope: z.union([scopeEnum, z.array(scopeEnum)]).optional(),
  playerId: z.string().uuid().optional(),
  playerQuery: z.string().trim().min(1).max(128).optional(),
  text: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  flaggedOnly: boolFlag.optional(),
  source: sourceEnum.optional(),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

const countQuery = listQuery.pick({
  serverId: true,
  scope: true,
  playerId: true,
  playerQuery: true,
  text: true,
  from: true,
  to: true,
  flaggedOnly: true,
  source: true,
});

type ListQuery = z.infer<typeof listQuery>;
type CountQuery = z.infer<typeof countQuery>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function encodeCursor(sentAt: Date, id: bigint): string {
  return Buffer.from(`${sentAt.toISOString()}~${id.toString()}`).toString('base64url');
}

function decodeCursor(raw: string): { sentAt: Date; id: bigint } | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('~');
    if (sep < 0) return null;
    const sentAt = new Date(decoded.slice(0, sep));
    if (Number.isNaN(sentAt.getTime())) return null;
    const rawId = decoded.slice(sep + 1);
    if (!/^\d{1,19}$/.test(rawId)) return null;
    const id = BigInt(rawId);
    if (id > INT8_MAX) return null;
    return { sentAt, id };
  } catch {
    return null;
  }
}

/**
 * `panel_access` gate for the chat archive. The route also declares
 * `config.permissions: ['events:view']`, so an API token reaches it only when
 * delegated that scope (audit #114); this guard keeps a session whose role
 * lacks `panel_access` out even if it holds an explicit `events:view` row.
 * Authentication is enforced by the fail-closed hook in `plugins/auth.ts`.
 */
function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!requestUser(req).permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

const chatRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Chat rows of the player(s) `query` names: an exact SteamID64 or EOS id,
   * or a (normalised) nickname substring over current and past names. Kept
   * as subqueries so no id list is materialised (audit #117/#118).
   */
  function playerQueryClause(query: string): SQL | undefined {
    const alternatives: SQL[] = [];
    if (STEAM_ID_RE.test(query)) {
      alternatives.push(
        inArray(
          chatMessages.playerId,
          app.db
            .select({ id: players.id })
            .from(players)
            .where(eq(players.steamId64, BigInt(query))),
        ),
      );
    }
    alternatives.push(
      inArray(
        chatMessages.playerId,
        app.db.select({ id: players.id }).from(players).where(eq(players.eosId, query)),
      ),
    );
    const byName = playerNameMatch(chatMessages.playerId, query);
    if (byName) alternatives.push(byName);
    return or(...alternatives);
  }

  function buildFilters(query: CountQuery): SQL | undefined {
    const clauses: SQL[] = [];

    if (query.playerId) clauses.push(eq(chatMessages.playerId, query.playerId));

    const serverIds = asArray(query.serverId);
    if (serverIds.length > 0) clauses.push(inArray(chatMessages.serverId, serverIds));

    const scopes = asArray(query.scope);
    if (scopes.length > 0) clauses.push(inArray(chatMessages.scope, scopes));

    if (query.source) clauses.push(eq(chatMessages.source, query.source));
    if (query.flaggedOnly === 'true') clauses.push(eq(chatMessages.isFlagged, true));
    if (query.from) clauses.push(gte(chatMessages.sentAt, query.from));
    if (query.to) clauses.push(lte(chatMessages.sentAt, query.to));

    if (query.text) {
      const pattern = `%${escapeLike(query.text)}%`;
      clauses.push(sql`${chatMessages.message} ILIKE ${pattern}`);
    }

    if (query.playerQuery) {
      const byPlayer = playerQueryClause(query.playerQuery);
      if (byPlayer) clauses.push(byPlayer);
    }

    return clauses.length > 0 ? and(...clauses) : undefined;
  }

  fast.get(
    '/api/v1/chat/messages',
    {
      schema: { querystring: listQuery },
      config: { audit: false, permissions: ['events:view'] },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const query: ListQuery = req.query;
      const where = buildFilters(query);

      const clauses: SQL[] = where ? [where] : [];
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const cursorSentAt = cursor.sentAt.toISOString();
        const cursorId = cursor.id.toString();
        clauses.push(
          sql`(${chatMessages.sentAt} < ${cursorSentAt}::timestamptz OR (${chatMessages.sentAt} = ${cursorSentAt}::timestamptz AND ${chatMessages.id} < ${cursorId}::bigint))`,
        );
      }

      const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
      const rows = await app.db
        .select({
          id: chatMessages.id,
          serverId: chatMessages.serverId,
          scope: chatMessages.scope,
          message: chatMessages.message,
          source: chatMessages.source,
          isFlagged: chatMessages.isFlagged,
          teamId: chatMessages.teamId,
          squadId: chatMessages.squadId,
          sentAt: chatMessages.sentAt,
          playerId: chatMessages.playerId,
          nickname: players.canonicalName,
        })
        .from(chatMessages)
        .innerJoin(players, eq(players.id, chatMessages.playerId))
        .where(whereClause)
        .orderBy(desc(chatMessages.sentAt), desc(chatMessages.id))
        .limit(query.limit);

      const last = rows.length === query.limit ? rows[rows.length - 1] : null;
      return {
        items: rows.map((row) => ({
          id: Number(row.id),
          serverId: row.serverId,
          scope: row.scope,
          message: row.message,
          source: row.source,
          isFlagged: row.isFlagged,
          teamId: row.teamId,
          squadId: row.squadId,
          sentAt: row.sentAt.toISOString(),
          player: { id: row.playerId, nickname: row.nickname },
        })),
        next_cursor: last ? encodeCursor(last.sentAt, last.id) : null,
      };
    },
  );

  fast.get(
    '/api/v1/chat/messages/count',
    {
      schema: { querystring: countQuery },
      config: { audit: false, permissions: ['events:view'] },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const where = buildFilters(req.query);

      const countRows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(chatMessages)
        .where(where);
      return { count: countRows[0]?.total ?? 0 };
    },
  );
};

export default chatRoutes;
