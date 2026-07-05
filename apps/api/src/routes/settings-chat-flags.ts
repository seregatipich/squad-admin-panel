import { chatFlagRules, players } from '@squad/db/schema';
import {
  CHAT_FLAG_LOCALES,
  CHAT_FLAG_PATTERN_TYPES,
  type ChatFlagPatternType,
  validateChatFlagPattern,
} from '@squad/shared-config';
import { and, desc, eq, ilike, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { reindexChatFlags } from '../lib/chat-flags.js';

const patternTypeSchema = z.enum(CHAT_FLAG_PATTERN_TYPES);
const localeSchema = z.enum(CHAT_FLAG_LOCALES);
const idParam = z.object({ id: z.string().uuid() });

const REINDEX_DAYS_MAX = 365;

const listQuery = z.object({
  search: z.string().trim().max(256).optional(),
  pattern_type: patternTypeSchema.optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

const createBody = z.object({
  pattern: z.string(),
  pattern_type: patternTypeSchema.default('word'),
  locale: localeSchema.default('all'),
  enabled: z.boolean().default(true),
});

const updateBody = z
  .object({
    pattern: z.string().optional(),
    pattern_type: patternTypeSchema.optional(),
    locale: localeSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

const reindexBody = z.object({
  days: z.coerce.number().int().min(1).max(REINDEX_DAYS_MAX),
});

interface RuleView {
  id: string;
  pattern: string;
  pattern_type: string;
  locale: string;
  enabled: boolean;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

function serializeRule(row: {
  id: string;
  pattern: string;
  pattern_type: string;
  locale: string;
  enabled: boolean;
  created_by: string | null;
  author_name: string | null;
  created_at: Date;
}): RuleView {
  return {
    id: row.id,
    pattern: row.pattern,
    pattern_type: row.pattern_type,
    locale: row.locale,
    enabled: row.enabled,
    created_by: row.created_by,
    author_name: row.author_name,
    created_at: row.created_at.toISOString(),
  };
}

function snapshot(row: typeof chatFlagRules.$inferSelect) {
  return {
    id: row.id,
    pattern: row.pattern,
    pattern_type: row.patternType,
    locale: row.locale,
    enabled: row.enabled,
    created_by: row.createdBy,
  };
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

function editGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.canEditRoles) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_edit_roles' };
  }
  return null;
}

const settingsChatFlagsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function auditMutation(
    req: FastifyRequest,
    reply: FastifyReply,
    input: { action: string; targetId: string; before: unknown; after: unknown },
  ): Promise<void> {
    if (!req.user) return;
    await writeAuditEntry(app.db, {
      actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
      actorIp: req.ip ?? null,
      actionType: input.action,
      targetType: 'chat_flag_rule',
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
  }

  async function loadRule(id: string): Promise<typeof chatFlagRules.$inferSelect | undefined> {
    const rows = await app.db.select().from(chatFlagRules).where(eq(chatFlagRules.id, id)).limit(1);
    return rows[0];
  }

  async function authorName(playerId: string | null): Promise<string | null> {
    if (!playerId) return null;
    const rows = await app.db
      .select({ name: players.canonicalName })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  fast.get(
    '/api/v1/settings/chat-flag-rules',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const { search, pattern_type, enabled } = req.query;
      const conditions: SQL[] = [];
      if (search) conditions.push(ilike(chatFlagRules.pattern, `%${search}%`));
      if (pattern_type) conditions.push(eq(chatFlagRules.patternType, pattern_type));
      if (enabled !== undefined) conditions.push(eq(chatFlagRules.enabled, enabled === 'true'));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await app.db
        .select({
          id: chatFlagRules.id,
          pattern: chatFlagRules.pattern,
          pattern_type: chatFlagRules.patternType,
          locale: chatFlagRules.locale,
          enabled: chatFlagRules.enabled,
          created_by: chatFlagRules.createdBy,
          author_name: players.canonicalName,
          created_at: chatFlagRules.createdAt,
        })
        .from(chatFlagRules)
        .leftJoin(players, eq(players.id, chatFlagRules.createdBy))
        .where(whereClause)
        .orderBy(desc(chatFlagRules.createdAt));

      return {
        items: rows.map(serializeRule),
        can_mutate: req.user?.permissions.canEditRoles ?? false,
      };
    },
  );

  fast.post(
    '/api/v1/settings/chat-flag-rules',
    { schema: { body: createBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = editGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const pattern = req.body.pattern.trim();
      const patternType = req.body.pattern_type as ChatFlagPatternType;
      const validation = validateChatFlagPattern(pattern, patternType);
      if (!validation.ok) {
        reply.code(422);
        return { error: 'invalid_pattern', detail: validation.error };
      }

      let inserted: typeof chatFlagRules.$inferSelect | undefined;
      try {
        const result = await app.db
          .insert(chatFlagRules)
          .values({
            pattern,
            patternType,
            locale: req.body.locale,
            enabled: req.body.enabled,
            createdBy: actorId,
          })
          .returning();
        inserted = result[0];
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'rule_already_exists' };
        }
        throw err;
      }
      if (!inserted) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      reply.code(201);
      await auditMutation(req, reply, {
        action: 'chat_flag_rule.create',
        targetId: inserted.id,
        before: null,
        after: snapshot(inserted),
      });
      return serializeRule({
        ...inserted,
        pattern_type: inserted.patternType,
        created_by: inserted.createdBy,
        author_name: req.user?.canonicalName ?? null,
        created_at: inserted.createdAt,
      });
    },
  );

  fast.patch(
    '/api/v1/settings/chat-flag-rules/:id',
    { schema: { params: idParam, body: updateBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = editGuard(req, reply);
      if (denied) return denied;
      const existing = await loadRule(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'rule_not_found' };
      }
      const nextPattern =
        req.body.pattern !== undefined ? req.body.pattern.trim() : existing.pattern;
      const nextPatternType = (req.body.pattern_type ??
        existing.patternType) as ChatFlagPatternType;
      if (req.body.pattern !== undefined || req.body.pattern_type !== undefined) {
        const validation = validateChatFlagPattern(nextPattern, nextPatternType);
        if (!validation.ok) {
          reply.code(422);
          return { error: 'invalid_pattern', detail: validation.error };
        }
      }

      const updates: Partial<typeof chatFlagRules.$inferInsert> = {};
      if (req.body.pattern !== undefined) updates.pattern = nextPattern;
      if (req.body.pattern_type !== undefined) updates.patternType = nextPatternType;
      if (req.body.locale !== undefined) updates.locale = req.body.locale;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

      let updated: typeof chatFlagRules.$inferSelect | undefined = existing;
      try {
        const result = await app.db
          .update(chatFlagRules)
          .set(updates)
          .where(eq(chatFlagRules.id, req.params.id))
          .returning();
        updated = result[0];
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'rule_already_exists' };
        }
        throw err;
      }
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await auditMutation(req, reply, {
        action: 'chat_flag_rule.update',
        targetId: updated.id,
        before: snapshot(existing),
        after: snapshot(updated),
      });
      return serializeRule({
        ...updated,
        pattern_type: updated.patternType,
        created_by: updated.createdBy,
        author_name: await authorName(updated.createdBy),
        created_at: updated.createdAt,
      });
    },
  );

  fast.delete(
    '/api/v1/settings/chat-flag-rules/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = editGuard(req, reply);
      if (denied) return denied;
      const existing = await loadRule(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'rule_not_found' };
      }
      await app.db.delete(chatFlagRules).where(eq(chatFlagRules.id, req.params.id));
      await auditMutation(req, reply, {
        action: 'chat_flag_rule.delete',
        targetId: existing.id,
        before: snapshot(existing),
        after: null,
      });
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/settings/chat-flag-rules/reindex',
    { schema: { body: reindexBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = editGuard(req, reply);
      if (denied) return denied;
      const summary = await reindexChatFlags(app.db, { days: req.body.days });
      await auditMutation(req, reply, {
        action: 'chat_flag_rule.reindex',
        targetId: `days:${summary.days}`,
        before: null,
        after: summary,
      });
      return summary;
    },
  );
};

export default settingsChatFlagsRoutes;
