import { type MarkTypeRow, markTypes } from '@squad/db/schema';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import {
  isMarkTypeIcon,
  MARK_TYPE_ICONS,
  MARK_TYPE_SEVERITY_MAX,
  MARK_TYPE_SEVERITY_MIN,
} from '../lib/mark-types.js';

const LABEL_MAX = 64;
const SLUG_MAX = 40;
const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(SLUG_MAX)
  .regex(/^[a-z0-9_]+$/, 'slug must be lowercase letters, digits or underscore');
const iconSchema = z.enum(MARK_TYPE_ICONS);
const severitySchema = z.number().int().min(MARK_TYPE_SEVERITY_MIN).max(MARK_TYPE_SEVERITY_MAX);

const createBody = z.object({
  slug: slugSchema,
  label_en: z.string().trim().min(1).max(LABEL_MAX),
  label_ru: z.string().trim().min(1).max(LABEL_MAX),
  icon: iconSchema,
  severity: severitySchema,
});

const updateBody = z
  .object({
    label_en: z.string().trim().min(1).max(LABEL_MAX),
    label_ru: z.string().trim().min(1).max(LABEL_MAX),
    icon: iconSchema,
    severity: severitySchema,
    is_active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty update' });

const ID_MAX = 32767;
const reorderBody = z.object({
  ordered_ids: z.array(z.number().int().positive().max(ID_MAX)).min(1).max(256),
});

const idParam = z.object({ id: z.coerce.number().int().positive().max(ID_MAX) });

function serialize(row: MarkTypeRow) {
  return {
    id: row.id,
    slug: row.slug,
    label_en: row.labelEn,
    label_ru: row.labelRu,
    icon: row.icon,
    severity: row.severity,
    is_active: row.isActive,
    sort_order: row.sortOrder,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const markTypesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/mark-types',
    { schema: { body: createBody }, config: { permissions: ['role:edit'], audit: false } },
    async (req, reply) => {
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!isMarkTypeIcon(req.body.icon)) {
        reply.code(400);
        return { error: 'unknown_icon' };
      }

      const slugTaken = await app.db
        .select({ id: markTypes.id })
        .from(markTypes)
        .where(eq(markTypes.slug, req.body.slug))
        .limit(1);
      if (slugTaken.length > 0) {
        reply.code(409);
        return { error: 'slug_already_exists' };
      }

      let row: MarkTypeRow;
      try {
        row = await app.db.transaction(async (tx) => {
          const [bounds] = await tx
            .select({
              nextId: sql<number>`COALESCE(MAX(${markTypes.id}), 0) + 1`,
              nextSort: sql<number>`COALESCE(MAX(${markTypes.sortOrder}), 0) + 1`,
            })
            .from(markTypes);
          const inserted = await tx
            .insert(markTypes)
            .values({
              id: bounds?.nextId ?? 1,
              slug: req.body.slug,
              labelEn: req.body.label_en,
              labelRu: req.body.label_ru,
              icon: req.body.icon,
              severity: req.body.severity,
              isActive: true,
              sortOrder: bounds?.nextSort ?? 1,
            })
            .returning();
          const first = inserted[0];
          if (!first) throw new Error('insert_failed');
          return first;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'slug_already_exists' };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'mark_type.create',
        targetType: 'mark_type',
        targetId: String(row.id),
        before: null,
        after: serialize(row),
        context: { request_id: req.id },
        statusCode: 201,
      });

      app.liveBus.publish({
        type: 'mark_type.changed',
        ts: new Date().toISOString(),
        data: { action: 'created' },
      });

      reply.code(201);
      return serialize(row);
    },
  );

  fast.patch(
    '/api/v1/mark-types/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: { permissions: ['role:edit'], audit: false },
    },
    async (req, reply) => {
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const existing = await app.db
        .select()
        .from(markTypes)
        .where(eq(markTypes.id, req.params.id))
        .limit(1);
      const current = existing[0];
      if (!current) {
        reply.code(404);
        return { error: 'mark_type_not_found' };
      }

      const updates: Partial<typeof markTypes.$inferInsert> = {};
      if (req.body.label_en !== undefined) updates.labelEn = req.body.label_en;
      if (req.body.label_ru !== undefined) updates.labelRu = req.body.label_ru;
      if (req.body.icon !== undefined) updates.icon = req.body.icon;
      if (req.body.severity !== undefined) updates.severity = req.body.severity;
      if (req.body.is_active !== undefined) updates.isActive = req.body.is_active;

      const updated = await app.db
        .update(markTypes)
        .set(updates)
        .where(eq(markTypes.id, req.params.id))
        .returning();
      const row = updated[0];
      if (!row) {
        reply.code(500);
        return { error: 'update_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'mark_type.update',
        targetType: 'mark_type',
        targetId: String(row.id),
        before: serialize(current),
        after: serialize(row),
        context: { request_id: req.id },
        statusCode: 200,
      });

      app.liveBus.publish({
        type: 'mark_type.changed',
        ts: new Date().toISOString(),
        data: { action: 'updated' },
      });

      return serialize(row);
    },
  );

  fast.patch(
    '/api/v1/mark-types/reorder',
    { schema: { body: reorderBody }, config: { permissions: ['role:edit'], audit: false } },
    async (req, reply) => {
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const orderedIds = req.body.ordered_ids;
      if (new Set(orderedIds).size !== orderedIds.length) {
        reply.code(400);
        return { error: 'duplicate_ids' };
      }

      const rows = await app.db.transaction(async (tx) => {
        const found = await tx
          .select({ id: markTypes.id })
          .from(markTypes)
          .where(inArray(markTypes.id, orderedIds));
        if (found.length !== orderedIds.length) return null;
        for (let index = 0; index < orderedIds.length; index++) {
          await tx
            .update(markTypes)
            .set({ sortOrder: index + 1 })
            .where(eq(markTypes.id, orderedIds[index] as number));
        }
        return tx.select().from(markTypes).orderBy(asc(markTypes.sortOrder));
      });

      if (rows === null) {
        reply.code(400);
        return { error: 'unknown_mark_type_id' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'mark_type.reorder',
        targetType: 'mark_type',
        targetId: null,
        before: null,
        after: { ordered_ids: orderedIds },
        context: { request_id: req.id },
        statusCode: 200,
      });

      app.liveBus.publish({
        type: 'mark_type.changed',
        ts: new Date().toISOString(),
        data: { action: 'reordered' },
      });

      return rows.map(serialize);
    },
  );
};

export default markTypesRoutes;
