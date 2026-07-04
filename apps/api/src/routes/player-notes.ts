import { playerNotes, players, roles } from '@squad/db/schema';
import { and, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const BODY_MAX = 2000;
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const noteIdParams = z.object({ noteId: z.string().uuid() });
const noteBody = z.object({ body: z.string().trim().min(1).max(BODY_MAX) });
const listQuery = z.object({
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

interface NoteRow {
  id: string;
  playerId: string;
  authorId: string;
  authorName: string;
  authorRoleColor: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date | null;
}

interface NoteDto {
  id: string;
  player_id: string;
  author: { id: string; name: string; role_color: string | null };
  body: string;
  created_at: string;
  updated_at: string | null;
  edited: boolean;
}

function toDto(row: NoteRow): NoteDto {
  return {
    id: row.id,
    player_id: row.playerId,
    author: { id: row.authorId, name: row.authorName, role_color: row.authorRoleColor },
    body: row.body,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt ? row.updatedAt.toISOString() : null,
    edited: row.updatedAt != null,
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

const playerNotesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  function noteRowsQuery() {
    return app.db
      .select({
        id: playerNotes.id,
        playerId: playerNotes.playerId,
        authorId: playerNotes.authorId,
        authorName: players.canonicalName,
        authorRoleColor: roles.color,
        body: playerNotes.body,
        createdAt: playerNotes.createdAt,
        updatedAt: playerNotes.updatedAt,
      })
      .from(playerNotes)
      .innerJoin(players, eq(players.id, playerNotes.authorId))
      .leftJoin(roles, eq(roles.id, players.roleId));
  }

  async function loadNoteRaw(noteId: string) {
    const rows = await app.db.select().from(playerNotes).where(eq(playerNotes.id, noteId)).limit(1);
    return rows[0] ?? null;
  }

  function snapshot(row: NonNullable<Awaited<ReturnType<typeof loadNoteRaw>>>) {
    return {
      id: row.id,
      player_id: row.playerId,
      author_id: row.authorId,
      body: row.body,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt ? row.updatedAt.toISOString() : null,
      deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
      deleted_by: row.deletedBy,
    };
  }

  fast.get(
    '/api/v1/players/:playerId/notes',
    { schema: { params: playerIdParams, querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const playerId = req.params.playerId;
      const limit = req.query.limit ?? PAGE_SIZE_DEFAULT;

      let keyset: SQL | undefined;
      if (req.query.cursor) {
        const parsed = parseCursor(req.query.cursor);
        if (!parsed) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        keyset = or(
          lt(playerNotes.createdAt, parsed.createdAt),
          and(eq(playerNotes.createdAt, parsed.createdAt), lt(playerNotes.id, parsed.id)),
        );
      }

      const rows = await noteRowsQuery()
        .where(and(eq(playerNotes.playerId, playerId), isNull(playerNotes.deletedAt), keyset))
        .orderBy(desc(playerNotes.createdAt), desc(playerNotes.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last) : null;

      const totalRows = await app.db
        .select({ c: sql<number>`count(*)::int` })
        .from(playerNotes)
        .where(and(eq(playerNotes.playerId, playerId), isNull(playerNotes.deletedAt)));

      return {
        items: page.map(toDto),
        next_cursor: nextCursor,
        total: totalRows[0]?.c ?? 0,
      };
    },
  );

  fast.post(
    '/api/v1/players/:playerId/notes',
    { schema: { params: playerIdParams, body: noteBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const playerId = req.params.playerId;
      const target = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const id = uuidv7();
      await app.db.insert(playerNotes).values({
        id,
        playerId,
        authorId: req.user.playerId,
        body: req.body.body,
      });

      const raw = await loadNoteRaw(id);
      const dtoRows = await noteRowsQuery().where(eq(playerNotes.id, id)).limit(1);
      const row = dtoRows[0];
      if (!raw || !row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      const dto = toDto(row);

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player_note.create',
        targetType: 'player_note',
        targetId: id,
        before: null,
        after: snapshot(raw),
        context: { requestId: req.id, method: req.method, url: req.url, playerId },
      });

      app.liveBus.publish({
        type: 'note.created',
        ts: new Date().toISOString(),
        data: { player_id: playerId, note: dto },
      });

      reply.code(201);
      return dto;
    },
  );

  fast.patch(
    '/api/v1/notes/:noteId',
    { schema: { params: noteIdParams, body: noteBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const noteId = req.params.noteId;
      const existing = await loadNoteRaw(noteId);
      if (!existing || existing.deletedAt) {
        reply.code(404);
        return { error: 'note_not_found' };
      }
      if (existing.authorId !== req.user.playerId) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const before = snapshot(existing);
      await app.db
        .update(playerNotes)
        .set({ body: req.body.body, updatedAt: new Date() })
        .where(eq(playerNotes.id, noteId));

      const raw = await loadNoteRaw(noteId);
      const dtoRows = await noteRowsQuery().where(eq(playerNotes.id, noteId)).limit(1);
      const row = dtoRows[0];
      if (!raw || !row) {
        reply.code(500);
        return { error: 'update_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player_note.update',
        targetType: 'player_note',
        targetId: noteId,
        before,
        after: snapshot(raw),
        context: { requestId: req.id, method: req.method, url: req.url },
      });

      return toDto(row);
    },
  );

  fast.delete(
    '/api/v1/notes/:noteId',
    { schema: { params: noteIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const noteId = req.params.noteId;
      const existing = await loadNoteRaw(noteId);
      if (!existing || existing.deletedAt) {
        reply.code(404);
        return { error: 'note_not_found' };
      }
      const isAuthor = existing.authorId === req.user.playerId;
      if (!isAuthor && !req.user.permissions.canEditRoles) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const before = snapshot(existing);
      await app.db
        .update(playerNotes)
        .set({ deletedAt: new Date(), deletedBy: req.user.playerId })
        .where(eq(playerNotes.id, noteId));

      const raw = await loadNoteRaw(noteId);
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player_note.delete',
        targetType: 'player_note',
        targetId: noteId,
        before,
        after: raw ? snapshot(raw) : null,
        context: { requestId: req.id, method: req.method, url: req.url },
      });

      return { ok: true };
    },
  );
};

export default playerNotesRoutes;
