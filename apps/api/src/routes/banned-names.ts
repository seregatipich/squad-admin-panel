import { bannedNameRules, players } from '@squad/db/schema';
import {
  BANNED_NAME_ACTIONS,
  BANNED_NAME_MATCH_TYPES,
  type BannedNameMatchType,
  findBannedNameRuleMatch,
  isBannedNameAction,
  isBannedNameMatchType,
  validateBannedNamePattern,
} from '@squad/shared-config';
import { and, asc, desc, eq, ilike, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const matchTypeSchema = z.enum(BANNED_NAME_MATCH_TYPES);
const actionSchema = z.enum(BANNED_NAME_ACTIONS);
const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  search: z.string().trim().max(256).optional(),
  match_type: matchTypeSchema.optional(),
  is_active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

const createBody = z.object({
  pattern: z.string(),
  match_type: matchTypeSchema.default('exact'),
  reason: z.string().trim().max(512).nullish(),
  action: actionSchema.default('kick'),
  is_active: z.boolean().default(true),
});

const checkQuery = z.object({
  nick: z.string().trim().min(1).max(256),
});

const updateBody = z.object({
  pattern: z.string().optional(),
  match_type: matchTypeSchema.optional(),
  reason: z.string().trim().max(512).nullish(),
  action: actionSchema.optional(),
  is_active: z.boolean().optional(),
});

interface RuleRow {
  id: string;
  pattern: string;
  match_type: string;
  reason: string | null;
  action: string;
  is_active: boolean;
  created_by: string | null;
  author_name: string | null;
  created_at: Date;
  hit_count: number;
  last_hit_at: Date | null;
}

function serializeRule(row: RuleRow) {
  return {
    id: row.id,
    pattern: row.pattern,
    match_type: row.match_type,
    reason: row.reason,
    action: row.action,
    is_active: row.is_active,
    created_by: row.created_by,
    author_name: row.author_name,
    created_at: row.created_at.toISOString(),
    hit_count: row.hit_count,
    last_hit_at: row.last_hit_at ? row.last_hit_at.toISOString() : null,
  };
}

function snapshot(row: typeof bannedNameRules.$inferSelect) {
  return {
    id: row.id,
    pattern: row.pattern,
    match_type: row.matchType,
    reason: row.reason,
    action: row.action,
    is_active: row.isActive,
    created_by: row.createdBy,
    hit_count: row.hitCount,
  };
}

function hasBanPermission(req: FastifyRequest): boolean {
  return req.user?.permissions.squadPermissions.has('ban') ?? false;
}

const bannedNamesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function auditMutation(
    req: FastifyRequest,
    reply: FastifyReply,
    input: {
      action: string;
      targetId: string;
      before: unknown;
      after: unknown;
    },
  ): Promise<void> {
    if (!req.user) return;
    await writeAuditEntry(app.db, {
      actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
      actorIp: req.ip ?? null,
      actionType: input.action,
      targetType: 'banned_name',
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
  }

  fast.get(
    '/api/v1/banned-names',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const { search, match_type, is_active, page, page_size } = req.query;
      const conditions: SQL[] = [];
      if (search) conditions.push(ilike(bannedNameRules.pattern, `%${search}%`));
      if (match_type) conditions.push(eq(bannedNameRules.matchType, match_type));
      if (is_active !== undefined)
        conditions.push(eq(bannedNameRules.isActive, is_active === 'true'));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await app.db
        .select({
          id: bannedNameRules.id,
          pattern: bannedNameRules.pattern,
          match_type: bannedNameRules.matchType,
          reason: bannedNameRules.reason,
          action: bannedNameRules.action,
          is_active: bannedNameRules.isActive,
          created_by: bannedNameRules.createdBy,
          author_name: players.canonicalName,
          created_at: bannedNameRules.createdAt,
          hit_count: bannedNameRules.hitCount,
          last_hit_at: bannedNameRules.lastHitAt,
        })
        .from(bannedNameRules)
        .leftJoin(players, eq(players.id, bannedNameRules.createdBy))
        .where(whereClause)
        .orderBy(desc(bannedNameRules.createdAt))
        .limit(page_size)
        .offset((page - 1) * page_size);

      const totalRows = await app.db
        .select({ c: sql<number>`count(*)::int` })
        .from(bannedNameRules)
        .where(whereClause);

      return {
        items: rows.map(serializeRule),
        total: totalRows[0]?.c ?? 0,
        page,
        page_size,
        can_mutate: hasBanPermission(req),
      };
    },
  );

  // BANNAME-3: lets any surface (player card, live roster, chat) check
  // whether a nickname currently matches an active rule, so a «Ник забанен»
  // badge / «Разбанить ник» action can be offered in place, without
  // duplicating the enforcement matcher. Loads active rules in the same
  // `created_at, id` order the log-ingest worker's rule cache uses, so the
  // badge never disagrees with what actually gets kicked.
  fast.get(
    '/api/v1/banned-names/check',
    { schema: { querystring: checkQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const rows = await app.db
        .select({
          id: bannedNameRules.id,
          pattern: bannedNameRules.pattern,
          match_type: bannedNameRules.matchType,
          action: bannedNameRules.action,
          reason: bannedNameRules.reason,
          is_active: bannedNameRules.isActive,
        })
        .from(bannedNameRules)
        .where(eq(bannedNameRules.isActive, true))
        .orderBy(asc(bannedNameRules.createdAt), asc(bannedNameRules.id));
      const activeRules = rows.map((row) => ({
        id: row.id,
        pattern: row.pattern,
        match_type: isBannedNameMatchType(row.match_type) ? row.match_type : ('exact' as const),
        action: isBannedNameAction(row.action) ? row.action : ('kick' as const),
        reason: row.reason,
        is_active: row.is_active,
      }));
      const matched = findBannedNameRuleMatch(activeRules, req.query.nick);
      return {
        matched: matched !== null,
        rule: matched
          ? {
              id: matched.id,
              pattern: matched.pattern,
              match_type: matched.match_type,
              action: matched.action,
              reason: matched.reason,
              is_active: matched.is_active,
            }
          : null,
        can_mutate: hasBanPermission(req),
      };
    },
  );

  fast.post(
    '/api/v1/banned-names',
    { schema: { body: createBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!hasBanPermission(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'ban' };
      }
      const pattern = req.body.pattern.trim();
      const matchType = req.body.match_type as BannedNameMatchType;
      const validation = validateBannedNamePattern(pattern, matchType);
      if (!validation.ok) {
        reply.code(422);
        return { error: 'invalid_pattern', detail: validation.error };
      }
      const reason = req.body.reason ? req.body.reason : null;
      const id = uuidv7();
      let inserted: typeof bannedNameRules.$inferSelect | undefined;
      try {
        const result = await app.db
          .insert(bannedNameRules)
          .values({
            id,
            pattern,
            matchType,
            reason,
            action: req.body.action,
            isActive: req.body.is_active,
            createdBy: req.user.playerId,
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
        action: 'banned_name.create',
        targetId: inserted.id,
        before: null,
        after: snapshot(inserted),
      });
      return serializeRule(toRuleRow(inserted, req.user.canonicalName));
    },
  );

  fast.patch(
    '/api/v1/banned-names/:id',
    { schema: { params: idParam, body: updateBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!hasBanPermission(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'ban' };
      }
      const existingRows = await app.db
        .select()
        .from(bannedNameRules)
        .where(eq(bannedNameRules.id, req.params.id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        reply.code(404);
        return { error: 'rule_not_found' };
      }
      const nextPattern =
        req.body.pattern !== undefined ? req.body.pattern.trim() : existing.pattern;
      const nextMatchType = (req.body.match_type ?? existing.matchType) as BannedNameMatchType;
      if (req.body.pattern !== undefined || req.body.match_type !== undefined) {
        const validation = validateBannedNamePattern(nextPattern, nextMatchType);
        if (!validation.ok) {
          reply.code(422);
          return { error: 'invalid_pattern', detail: validation.error };
        }
      }
      const updates: Partial<typeof bannedNameRules.$inferInsert> = {};
      if (req.body.pattern !== undefined) updates.pattern = nextPattern;
      if (req.body.match_type !== undefined) updates.matchType = nextMatchType;
      if (req.body.reason !== undefined) updates.reason = req.body.reason ? req.body.reason : null;
      if (req.body.action !== undefined) updates.action = req.body.action;
      if (req.body.is_active !== undefined) updates.isActive = req.body.is_active;

      let updated: typeof bannedNameRules.$inferSelect | undefined = existing;
      if (Object.keys(updates).length > 0) {
        try {
          const result = await app.db
            .update(bannedNameRules)
            .set(updates)
            .where(eq(bannedNameRules.id, req.params.id))
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
      }
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await auditMutation(req, reply, {
        action: 'banned_name.update',
        targetId: updated.id,
        before: snapshot(existing),
        after: snapshot(updated),
      });
      const authorRows = updated.createdBy
        ? await app.db
            .select({ name: players.canonicalName })
            .from(players)
            .where(eq(players.id, updated.createdBy))
            .limit(1)
        : [];
      return serializeRule(toRuleRow(updated, authorRows[0]?.name ?? null));
    },
  );

  fast.delete(
    '/api/v1/banned-names/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!hasBanPermission(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'ban' };
      }
      const existingRows = await app.db
        .select()
        .from(bannedNameRules)
        .where(eq(bannedNameRules.id, req.params.id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        reply.code(404);
        return { error: 'rule_not_found' };
      }
      await app.db.delete(bannedNameRules).where(eq(bannedNameRules.id, req.params.id));
      await auditMutation(req, reply, {
        action: 'banned_name.delete',
        targetId: existing.id,
        before: snapshot(existing),
        after: null,
      });
      return { ok: true };
    },
  );
};

function toRuleRow(row: typeof bannedNameRules.$inferSelect, authorName: string | null): RuleRow {
  return {
    id: row.id,
    pattern: row.pattern,
    match_type: row.matchType,
    reason: row.reason,
    action: row.action,
    is_active: row.isActive,
    created_by: row.createdBy,
    author_name: authorName,
    created_at: row.createdAt,
    hit_count: row.hitCount,
    last_hit_at: row.lastHitAt,
  };
}

export default bannedNamesRoutes;
