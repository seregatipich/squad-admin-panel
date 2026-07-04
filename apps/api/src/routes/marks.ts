import { markTypes, type PlayerMarkRow, playerMarks, players } from '@squad/db/schema';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { ensureMarkTypes } from '../lib/mark-types.js';

const COMMENT_MAX = 512;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const markParams = z.object({ playerId: z.string().uuid(), markId: z.string().uuid() });
const createMarkBody = z.object({
  mark_type_id: z.number().int().positive(),
  comment: z.string().trim().max(COMMENT_MAX).optional(),
});
const clearMarkBody = z
  .object({ clear_reason: z.string().trim().max(COMMENT_MAX).optional() })
  .nullish();
const listQuery = z.object({ include_cleared: z.enum(['true', 'false']).optional() });

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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function serializeMark(row: PlayerMarkRow) {
  return {
    id: row.id,
    player_id: row.playerId,
    mark_type_id: row.markTypeId,
    comment: row.comment,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    cleared_by: row.clearedBy,
    cleared_at: row.clearedAt ? row.clearedAt.toISOString() : null,
    clear_reason: row.clearReason,
    active: row.clearedAt === null,
  };
}

interface EnrichedMarkJoin {
  mark: PlayerMarkRow;
  typeSlug: string;
  typeLabelEn: string;
  typeLabelRu: string;
  typeIcon: string;
  typeSeverity: number;
  authorName: string | null;
  clearerName: string | null;
}

function enrichMark(row: EnrichedMarkJoin) {
  return {
    ...serializeMark(row.mark),
    mark_type: {
      id: row.mark.markTypeId,
      slug: row.typeSlug,
      label_en: row.typeLabelEn,
      label_ru: row.typeLabelRu,
      icon: row.typeIcon,
      severity: row.typeSeverity,
    },
    created_by_name: row.authorName,
    cleared_by_name: row.clearerName,
  };
}

const marksRoutes: FastifyPluginAsync = async (app) => {
  await ensureMarkTypes(app.db);
  const fast = app.withTypeProvider<ZodTypeProvider>();

  function enrichedMarkQuery() {
    const author = alias(players, 'mark_author');
    const clearer = alias(players, 'mark_clearer');
    return app.db
      .select({
        mark: playerMarks,
        typeSlug: markTypes.slug,
        typeLabelEn: markTypes.labelEn,
        typeLabelRu: markTypes.labelRu,
        typeIcon: markTypes.icon,
        typeSeverity: markTypes.severity,
        authorName: author.canonicalName,
        clearerName: clearer.canonicalName,
      })
      .from(playerMarks)
      .innerJoin(markTypes, eq(markTypes.id, playerMarks.markTypeId))
      .leftJoin(author, eq(author.id, playerMarks.createdBy))
      .leftJoin(clearer, eq(clearer.id, playerMarks.clearedBy));
  }

  async function loadMarkDto(markId: string) {
    const rows = await enrichedMarkQuery().where(eq(playerMarks.id, markId)).limit(1);
    const row = rows[0];
    return row ? enrichMark(row) : null;
  }

  async function publishMarkChange(
    playerId: string,
    markId: string,
    action: 'set' | 'cleared',
  ): Promise<void> {
    const mark = await loadMarkDto(markId);
    if (!mark) return;
    app.liveBus.publish({
      type: 'mark.changed',
      ts: new Date().toISOString(),
      data: { player_id: playerId, action, mark },
    });
  }

  fast.get('/api/v1/mark-types', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    const rows = await app.db
      .select()
      .from(markTypes)
      .where(eq(markTypes.isActive, true))
      .orderBy(asc(markTypes.sortOrder));
    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      label_en: t.labelEn,
      label_ru: t.labelRu,
      icon: t.icon,
      severity: t.severity,
      is_active: t.isActive,
      sort_order: t.sortOrder,
    }));
  });

  fast.get('/api/v1/marks/active-summary', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    const rows = await app.db
      .select({
        playerId: playerMarks.playerId,
        markTypeId: markTypes.id,
        slug: markTypes.slug,
        labelEn: markTypes.labelEn,
        labelRu: markTypes.labelRu,
        icon: markTypes.icon,
        severity: markTypes.severity,
      })
      .from(playerMarks)
      .innerJoin(markTypes, eq(markTypes.id, playerMarks.markTypeId))
      .where(isNull(playerMarks.clearedAt))
      .orderBy(desc(markTypes.severity), asc(markTypes.sortOrder));
    const byPlayer = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const marks = byPlayer.get(row.playerId) ?? [];
      marks.push({
        mark_type_id: row.markTypeId,
        slug: row.slug,
        label_en: row.labelEn,
        label_ru: row.labelRu,
        icon: row.icon,
        severity: row.severity,
      });
      byPlayer.set(row.playerId, marks);
    }
    return {
      items: Array.from(byPlayer.entries()).map(([player_id, marks]) => ({ player_id, marks })),
    };
  });

  fast.get(
    '/api/v1/players/:playerId/marks',
    { schema: { params: playerIdParams, querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const { playerId } = req.params;
      const includeCleared = req.query.include_cleared === 'true';
      const whereClause = includeCleared
        ? eq(playerMarks.playerId, playerId)
        : and(eq(playerMarks.playerId, playerId), isNull(playerMarks.clearedAt));
      const rows = await enrichedMarkQuery()
        .where(whereClause)
        .orderBy(desc(playerMarks.createdAt));
      return {
        items: rows.map(enrichMark),
        total: rows.length,
      };
    },
  );

  fast.post(
    '/api/v1/players/:playerId/marks',
    { schema: { params: playerIdParams, body: createMarkBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const { playerId } = req.params;
      const markTypeId = req.body.mark_type_id;

      const playerRow = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (playerRow.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const typeRow = await app.db
        .select({ id: markTypes.id, isActive: markTypes.isActive })
        .from(markTypes)
        .where(eq(markTypes.id, markTypeId))
        .limit(1);
      const markType = typeRow[0];
      if (!markType || !markType.isActive) {
        reply.code(404);
        return { error: 'mark_type_not_found' };
      }

      const existing = await app.db
        .select({ id: playerMarks.id })
        .from(playerMarks)
        .where(
          and(
            eq(playerMarks.playerId, playerId),
            eq(playerMarks.markTypeId, markTypeId),
            isNull(playerMarks.clearedAt),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        reply.code(409);
        return { error: 'mark_already_active' };
      }

      const id = uuidv7();
      let row: PlayerMarkRow;
      try {
        const inserted = await app.db
          .insert(playerMarks)
          .values({
            id,
            playerId,
            markTypeId,
            comment: req.body.comment ?? null,
            createdBy: actorId,
          })
          .returning();
        const first = inserted[0];
        if (!first) {
          reply.code(500);
          return { error: 'insert_failed' };
        }
        row = first;
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'mark_already_active' };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player.mark.set',
        targetType: 'player_mark',
        targetId: row.id,
        before: null,
        after: serializeMark(row),
        context: { player_id: playerId, mark_type_id: markTypeId, request_id: req.id },
        statusCode: 201,
      });

      await publishMarkChange(playerId, row.id, 'set');

      reply.code(201);
      return serializeMark(row);
    },
  );

  fast.delete(
    '/api/v1/players/:playerId/marks/:markId',
    { schema: { params: markParams, body: clearMarkBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const { playerId, markId } = req.params;
      const clearReason = req.body?.clear_reason ?? null;

      const rows = await app.db
        .select()
        .from(playerMarks)
        .where(and(eq(playerMarks.id, markId), eq(playerMarks.playerId, playerId)))
        .limit(1);
      const mark = rows[0];
      if (!mark) {
        reply.code(404);
        return { error: 'mark_not_found' };
      }
      if (mark.clearedAt) {
        reply.code(409);
        return { error: 'mark_already_cleared' };
      }

      const before = serializeMark(mark);
      const updated = await app.db
        .update(playerMarks)
        .set({ clearedBy: actorId, clearedAt: new Date(), clearReason })
        .where(eq(playerMarks.id, markId))
        .returning();
      const row = updated[0];
      if (!row) {
        reply.code(500);
        return { error: 'update_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player.mark.clear',
        targetType: 'player_mark',
        targetId: row.id,
        before,
        after: serializeMark(row),
        context: { player_id: playerId, mark_type_id: row.markTypeId, request_id: req.id },
        statusCode: 200,
      });

      await publishMarkChange(playerId, row.id, 'cleared');

      return serializeMark(row);
    },
  );
};

export default marksRoutes;
