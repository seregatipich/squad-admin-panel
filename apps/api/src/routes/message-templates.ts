import { messageTemplates } from '@squad/db/schema';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  ensureDefaultMessageTemplates,
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_LOCALES,
} from '../lib/message-templates.js';

const TITLE_MIN = 1;
const TITLE_MAX = 120;

const categorySchema = z.enum(MESSAGE_TEMPLATE_CATEGORIES);
const localeSchema = z.enum(MESSAGE_TEMPLATE_LOCALES);

const createBody = z.object({
  title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
  body: z.string().min(1).max(MESSAGE_BODY_MAX),
  category: categorySchema,
  locale: localeSchema,
  sort_order: z.number().int().min(0).max(100000).optional(),
  is_enabled: z.boolean().optional(),
});

const updateBody = z
  .object({
    title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
    body: z.string().min(1).max(MESSAGE_BODY_MAX),
    category: categorySchema,
    locale: localeSchema,
    sort_order: z.number().int().min(0).max(100000),
    is_enabled: z.boolean(),
  })
  .partial();

const idParam = z.object({ id: z.string().uuid() });

interface TemplateRow {
  id: string;
  title: string;
  body: string;
  category: string;
  locale: string;
  sortOrder: number;
  isEnabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(row: TemplateRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    locale: row.locale,
    sort_order: row.sortOrder,
    is_enabled: row.isEnabled,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const messageTemplatesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/message-templates', { config: { audit: false } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    await ensureDefaultMessageTemplates(app.db);
    const rows = await app.db
      .select()
      .from(messageTemplates)
      .orderBy(asc(messageTemplates.sortOrder), asc(messageTemplates.createdAt));
    return rows.map(serialize);
  });

  fast.post(
    '/api/v1/message-templates',
    {
      schema: { body: createBody },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'message_template.create', resource: 'message_template' },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      const inserted = await app.db
        .insert(messageTemplates)
        .values({
          id,
          title: req.body.title,
          body: req.body.body,
          category: req.body.category,
          locale: req.body.locale,
          sortOrder: req.body.sort_order ?? 0,
          isEnabled: req.body.is_enabled ?? true,
          createdBy: req.user?.playerId ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      reply.code(201);
      return serialize(row);
    },
  );

  fast.patch(
    '/api/v1/message-templates/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'message_template.update', resource: 'message_template' },
      },
    },
    async (req, reply) => {
      const existing = await app.db
        .select()
        .from(messageTemplates)
        .where(eq(messageTemplates.id, req.params.id))
        .limit(1);
      if (existing.length === 0) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      const updates: Partial<typeof messageTemplates.$inferInsert> = { updatedAt: new Date() };
      if (req.body.title !== undefined) updates.title = req.body.title;
      if (req.body.body !== undefined) updates.body = req.body.body;
      if (req.body.category !== undefined) updates.category = req.body.category;
      if (req.body.locale !== undefined) updates.locale = req.body.locale;
      if (req.body.sort_order !== undefined) updates.sortOrder = req.body.sort_order;
      if (req.body.is_enabled !== undefined) updates.isEnabled = req.body.is_enabled;
      const updated = await app.db
        .update(messageTemplates)
        .set(updates)
        .where(eq(messageTemplates.id, req.params.id))
        .returning();
      const row = updated[0];
      if (!row) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      return serialize(row);
    },
  );

  fast.delete(
    '/api/v1/message-templates/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'message_template.delete', resource: 'message_template' },
      },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(messageTemplates)
        .where(eq(messageTemplates.id, req.params.id))
        .returning({ id: messageTemplates.id });
      if (deleted.length === 0) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      return { ok: true };
    },
  );
};

export default messageTemplatesRoutes;
