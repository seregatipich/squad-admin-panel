import { playerNameHistory, playerNotes, players, roles } from '@squad/db/schema';
import {
  and,
  desc,
  eq,
  exists,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 10_000;

const targetPlayer = alias(players, 'target_player');
const authorPlayer = alias(players, 'author_player');
const deleterPlayer = alias(players, 'deleter_player');

const filterShape = {
  q: z.string().trim().min(1).max(200).optional(),
  player: z.string().trim().min(1).max(200).optional(),
  author: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  includeDeleted: z.enum(['true', 'false']).default('false'),
};

const listQuery = z.object({
  ...filterShape,
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

const exportQuery = z.object({ ...filterShape, format: z.literal('csv').default('csv') });

type FilterInput = z.infer<z.ZodObject<typeof filterShape>>;

interface FeedRow {
  id: string;
  playerId: string;
  targetName: string;
  authorId: string;
  authorName: string;
  authorRoleColor: string | null;
  authorRoleName: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
  deletedById: string | null;
  deletedByName: string | null;
}

interface FeedDto {
  id: string;
  player_id: string;
  target: { id: string; name: string };
  author: { id: string; name: string; role_color: string | null; role_name: string | null };
  body: string;
  created_at: string;
  updated_at: string | null;
  edited: boolean;
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: { id: string; name: string | null } | null;
}

function toDto(row: FeedRow): FeedDto {
  return {
    id: row.id,
    player_id: row.playerId,
    target: { id: row.playerId, name: row.targetName },
    author: {
      id: row.authorId,
      name: row.authorName,
      role_color: row.authorRoleColor,
      role_name: row.authorRoleName,
    },
    body: row.body,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt ? row.updatedAt.toISOString() : null,
    edited: row.updatedAt != null,
    deleted: row.deletedAt != null,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    deleted_by: row.deletedAt ? { id: row.deletedById ?? '', name: row.deletedByName } : null,
  };
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}_${row.id}`;
}

function parseCursor(raw: string): { createdAt: Date; id: string } | null {
  const sep = raw.indexOf('_');
  if (sep === -1) return null;
  const millis = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(millis) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt: new Date(millis), id };
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

const CSV_COLUMNS = [
  'created_at',
  'author',
  'author_role',
  'target_player',
  'target_player_id',
  'body',
  'edited',
  'deleted',
  'deleted_at',
  'deleted_by',
] as const;

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(dto: FeedDto): string {
  const cells = [
    dto.created_at,
    dto.author.name,
    dto.author.role_name,
    dto.target.name,
    dto.player_id,
    dto.body,
    dto.edited,
    dto.deleted,
    dto.deleted_at,
    dto.deleted_by ? dto.deleted_by.name : null,
  ];
  return cells.map(csvCell).join(',');
}

const notesFeedRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  function feedSelection() {
    return app.db
      .select({
        id: playerNotes.id,
        playerId: playerNotes.playerId,
        targetName: targetPlayer.canonicalName,
        authorId: playerNotes.authorId,
        authorName: authorPlayer.canonicalName,
        authorRoleColor: roles.color,
        authorRoleName: roles.name,
        body: playerNotes.body,
        createdAt: playerNotes.createdAt,
        updatedAt: playerNotes.updatedAt,
        deletedAt: playerNotes.deletedAt,
        deletedById: playerNotes.deletedBy,
        deletedByName: deleterPlayer.canonicalName,
      })
      .from(playerNotes)
      .innerJoin(targetPlayer, eq(targetPlayer.id, playerNotes.playerId))
      .innerJoin(authorPlayer, eq(authorPlayer.id, playerNotes.authorId))
      .leftJoin(roles, eq(roles.id, authorPlayer.roleId))
      .leftJoin(deleterPlayer, eq(deleterPlayer.id, playerNotes.deletedBy));
  }

  function nameHistoryExists(pattern: string): SQL {
    return exists(
      app.db
        .select({ one: sql`1` })
        .from(playerNameHistory)
        .where(
          and(
            eq(playerNameHistory.playerId, playerNotes.playerId),
            ilike(playerNameHistory.name, pattern),
          ),
        ),
    );
  }

  function filters(query: FilterInput, canEditRoles: boolean): SQL[] {
    const clauses: SQL[] = [];
    if (!(canEditRoles && query.includeDeleted === 'true')) {
      clauses.push(isNull(playerNotes.deletedAt));
    }
    if (query.q) clauses.push(ilike(playerNotes.body, `%${escapeLike(query.q)}%`));
    if (query.author) clauses.push(eq(playerNotes.authorId, query.author));
    if (query.dateFrom) clauses.push(gte(playerNotes.createdAt, query.dateFrom));
    if (query.dateTo) clauses.push(lte(playerNotes.createdAt, query.dateTo));
    if (query.player) {
      const pattern = `%${escapeLike(query.player)}%`;
      const match = or(ilike(targetPlayer.canonicalName, pattern), nameHistoryExists(pattern));
      if (match) clauses.push(match);
    }
    return clauses;
  }

  fast.get(
    '/api/v1/notes',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const canEditRoles = req.user?.permissions.canEditRoles ?? false;
      const limit = req.query.limit ?? PAGE_SIZE_DEFAULT;
      const clauses = filters(req.query, canEditRoles);

      if (req.query.cursor) {
        const parsed = parseCursor(req.query.cursor);
        if (!parsed) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        clauses.push(
          or(
            lt(playerNotes.createdAt, parsed.createdAt),
            and(eq(playerNotes.createdAt, parsed.createdAt), lt(playerNotes.id, parsed.id)),
          ) as SQL,
        );
      }

      const rows = await feedSelection()
        .where(and(...clauses))
        .orderBy(desc(playerNotes.createdAt), desc(playerNotes.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last) : null;

      return {
        items: page.map(toDto),
        next_cursor: nextCursor,
        can_view_deleted: canEditRoles,
      };
    },
  );

  fast.get('/api/v1/notes/authors', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;

    const rows = await app.db
      .selectDistinct({
        id: authorPlayer.id,
        name: authorPlayer.canonicalName,
        roleColor: roles.color,
        roleName: roles.name,
      })
      .from(playerNotes)
      .innerJoin(authorPlayer, eq(authorPlayer.id, playerNotes.authorId))
      .leftJoin(roles, eq(roles.id, authorPlayer.roleId))
      .where(isNotNull(authorPlayer.roleId))
      .orderBy(authorPlayer.canonicalName);

    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role_color: r.roleColor,
        role_name: r.roleName,
      })),
    };
  });

  fast.get(
    '/api/v1/notes/export',
    { schema: { querystring: exportQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) {
        reply.header('content-type', 'application/json; charset=utf-8');
        return denied;
      }

      const canEditRoles = req.user?.permissions.canEditRoles ?? false;
      const clauses = filters(req.query, canEditRoles);
      const rows = await feedSelection()
        .where(and(...clauses))
        .orderBy(desc(playerNotes.createdAt), desc(playerNotes.id))
        .limit(EXPORT_MAX);

      const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => csvRow(toDto(r)))];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="notes-${stamp}.csv"`);
      return reply.send(body);
    },
  );
};

export default notesFeedRoutes;
