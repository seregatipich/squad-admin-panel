import { type PlayerNoteRow, playerNotes, players, roles } from '@squad/db/schema';
import { and, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';

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

/**
 * Keyset cursor: `<created_at as UTC ISO-8601 with microseconds>_<id>`.
 *
 * `created_at` is stored with microsecond precision, so the cursor must carry
 * all six fractional digits — a millisecond cursor made the `(created_at, id)`
 * keyset skip notes written within the same millisecond as a page's last row.
 * The timestamp text is rendered by Postgres (see `cursorTs` in
 * `noteRowsQuery`) because a JS `Date` cannot hold microseconds.
 */
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/i;

function encodeCursor(row: { cursorTs: string; id: string }): string {
  return `${row.cursorTs}_${row.id}`;
}

function parseCursor(raw: string): { createdAt: string; id: string } | null {
  const match = CURSOR_RE.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  if (Number.isNaN(Date.parse(match[1]))) return null;
  return { createdAt: match[1], id: match[2] };
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
        cursorTs: sql<string>`to_char(${playerNotes.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(playerNotes)
      .innerJoin(players, eq(players.id, playerNotes.authorId))
      .leftJoin(roles, eq(roles.id, players.roleId));
  }

  function snapshot(row: PlayerNoteRow) {
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

  function auditActorId(req: FastifyRequest): string {
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view permission gate
    return req.user!.playerId;
  }

  function auditActor(req: FastifyRequest): AuditActor {
    return { kind: 'steam', playerId: auditActorId(req), tokenId: req.apiTokenId ?? null };
  }

  fast.get(
    '/api/v1/players/:playerId/notes',
    {
      schema: { params: playerIdParams, querystring: listQuery },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
      const playerId = req.params.playerId;
      const limit = req.query.limit ?? PAGE_SIZE_DEFAULT;

      let keyset: SQL | undefined;
      if (req.query.cursor) {
        const parsed = parseCursor(req.query.cursor);
        if (!parsed) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const cursorCreatedAt = sql`${parsed.createdAt}::timestamptz`;
        keyset = or(
          sql`${playerNotes.createdAt} < ${cursorCreatedAt}`,
          and(sql`${playerNotes.createdAt} = ${cursorCreatedAt}`, lt(playerNotes.id, parsed.id)),
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
    {
      schema: { params: playerIdParams, body: noteBody },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
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
      await app.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(playerNotes)
          .values({ id, playerId, authorId: auditActorId(req), body: req.body.body })
          .returning();
        if (!inserted) throw new Error('player_notes insert returned no row');
        await writeAuditEntry(tx, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'player_note.create',
          targetType: 'player_note',
          targetId: id,
          before: null,
          after: snapshot(inserted),
          context: { requestId: req.id, method: req.method, url: req.url, playerId },
        });
      });

      const dtoRows = await noteRowsQuery().where(eq(playerNotes.id, id)).limit(1);
      const row = dtoRows[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      const dto = toDto(row);

      app.liveBus.publish({
        type: 'note.created',
        ts: new Date().toISOString(),
        data: { player_id: playerId, note: dto },
      });

      reply.code(201);
      return dto;
    },
  );

  /*
   * PATCH and DELETE lock the note row (`FOR UPDATE`) before checking it, and
   * write the mutation and its audit row in that same transaction: a note
   * deleted concurrently can no longer be edited or deleted a second time,
   * and a failed audit insert rolls the mutation back instead of leaving it
   * unaudited.
   */
  fast.patch(
    '/api/v1/notes/:noteId',
    {
      schema: { params: noteIdParams, body: noteBody },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
      const noteId = req.params.noteId;
      const actorId = auditActorId(req);
      const outcome = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(playerNotes)
          .where(eq(playerNotes.id, noteId))
          .limit(1)
          .for('update');
        if (!existing || existing.deletedAt) return { code: 404, error: 'note_not_found' } as const;
        if (existing.authorId !== actorId) return { code: 403, error: 'forbidden' } as const;

        const [updated] = await tx
          .update(playerNotes)
          .set({ body: req.body.body, updatedAt: new Date() })
          .where(and(eq(playerNotes.id, noteId), isNull(playerNotes.deletedAt)))
          .returning();
        if (!updated) return { code: 404, error: 'note_not_found' } as const;

        await writeAuditEntry(tx, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'player_note.update',
          targetType: 'player_note',
          targetId: noteId,
          before: snapshot(existing),
          after: snapshot(updated),
          context: { requestId: req.id, method: req.method, url: req.url },
        });
        return null;
      });
      if (outcome) {
        reply.code(outcome.code);
        return { error: outcome.error };
      }

      const dtoRows = await noteRowsQuery().where(eq(playerNotes.id, noteId)).limit(1);
      const row = dtoRows[0];
      if (!row) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      return toDto(row);
    },
  );

  fast.delete(
    '/api/v1/notes/:noteId',
    {
      schema: { params: noteIdParams },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
      const noteId = req.params.noteId;
      const actorId = auditActorId(req);
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view permission gate
      const canDeleteOthers = req.user!.permissions.canEditRoles;
      const outcome = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(playerNotes)
          .where(eq(playerNotes.id, noteId))
          .limit(1)
          .for('update');
        if (!existing || existing.deletedAt) return { code: 404, error: 'note_not_found' } as const;
        if (existing.authorId !== actorId && !canDeleteOthers) {
          return { code: 403, error: 'forbidden' } as const;
        }

        const [deleted] = await tx
          .update(playerNotes)
          .set({ deletedAt: new Date(), deletedBy: actorId })
          .where(and(eq(playerNotes.id, noteId), isNull(playerNotes.deletedAt)))
          .returning();
        if (!deleted) return { code: 404, error: 'note_not_found' } as const;

        await writeAuditEntry(tx, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'player_note.delete',
          targetType: 'player_note',
          targetId: noteId,
          before: snapshot(existing),
          after: snapshot(deleted),
          context: { requestId: req.id, method: req.method, url: req.url },
        });
        return null;
      });
      if (outcome) {
        reply.code(outcome.code);
        return { error: outcome.error };
      }
      return { ok: true };
    },
  );
};

export default playerNotesRoutes;
