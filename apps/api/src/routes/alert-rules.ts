import { alertEvents, alertRules } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

const ALERT_RULE_TYPES = [
  'server_crashed',
  'unusual_activity',
  'admin_login_new_ip',
  'custom',
] as const;
const ALERT_CHANNELS = ['email', 'webpush'] as const;

const configSchema = z.record(z.unknown());

const createBody = z
  .object({
    name: z.string().trim().min(1).max(128),
    type: z.enum(ALERT_RULE_TYPES),
    config: configSchema.default({}),
    channels: z.array(z.enum(ALERT_CHANNELS)).max(2).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'custom') {
      const kind = value.config.eventKind;
      if (typeof kind !== 'string' || kind.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'eventKind'],
          message: 'custom rules require a non-empty eventKind',
        });
      }
    }
    if (value.type === 'unusual_activity') {
      const threshold = value.config.connectThreshold;
      if (typeof threshold !== 'number' || threshold <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'connectThreshold'],
          message: 'unusual_activity rules require a positive connectThreshold',
        });
      }
    }
  });

const updateBody = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  config: configSchema.optional(),
  channels: z.array(z.enum(ALERT_CHANNELS)).max(2).optional(),
  enabled: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  rule_id: z.string().uuid().optional(),
});

interface RuleRow {
  id: string;
  name: string;
  type: string;
  config: unknown;
  channels: unknown;
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeRule(row: RuleRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: (row.config ?? {}) as Record<string, unknown>,
    channels: (row.channels ?? []) as string[],
    enabled: row.enabled,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function denyRead(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return true;
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403).send({ error: 'forbidden' });
    return true;
  }
  return false;
}

const alertRulesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/alert-rules', { config: { audit: false } }, async (req, reply) => {
    if (denyRead(req, reply)) return;
    const rows = (await app.db
      .select()
      .from(alertRules)
      .orderBy(desc(alertRules.createdAt))) as unknown as RuleRow[];
    return rows.map(serializeRule);
  });

  fast.post(
    '/api/v1/alert-rules',
    {
      schema: { body: createBody },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'alert_rule.create', resource: 'alert_rule' },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      const inserted = (await app.db
        .insert(alertRules)
        .values({
          id,
          name: req.body.name,
          type: req.body.type,
          config: req.body.config,
          channels: req.body.channels,
          enabled: req.body.enabled,
          createdBy: req.user?.playerId ?? null,
        })
        .returning()) as unknown as RuleRow[];
      const row = inserted[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      reply.code(201);
      return serializeRule(row);
    },
  );

  fast.put(
    '/api/v1/alert-rules/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'alert_rule.update', resource: 'alert_rule' },
      },
    },
    async (req, reply) => {
      const existing = (await app.db
        .select()
        .from(alertRules)
        .where(eq(alertRules.id, req.params.id))
        .limit(1)) as unknown as RuleRow[];
      if (existing.length === 0) {
        reply.code(404);
        return { error: 'alert_rule_not_found' };
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.config !== undefined) updates.config = req.body.config;
      if (req.body.channels !== undefined) updates.channels = req.body.channels;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      const updated = (await app.db
        .update(alertRules)
        .set(updates)
        .where(eq(alertRules.id, req.params.id))
        .returning()) as unknown as RuleRow[];
      const row = updated[0];
      if (!row) {
        reply.code(404);
        return { error: 'alert_rule_not_found' };
      }
      return serializeRule(row);
    },
  );

  fast.delete(
    '/api/v1/alert-rules/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: ['role:edit'],
        audit: { action: 'alert_rule.delete', resource: 'alert_rule' },
      },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(alertRules)
        .where(eq(alertRules.id, req.params.id))
        .returning({ id: alertRules.id });
      if (deleted.length === 0) {
        reply.code(404);
        return { error: 'alert_rule_not_found' };
      }
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/alerts',
    { schema: { querystring: historyQuery }, config: { audit: false } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      const conditions = req.query.rule_id ? eq(alertEvents.ruleId, req.query.rule_id) : undefined;
      const rows = await app.db
        .select({
          id: alertEvents.id,
          rule_id: alertEvents.ruleId,
          rule_name: alertRules.name,
          rule_type: alertRules.type,
          triggered_at: alertEvents.triggeredAt,
          payload: alertEvents.payload,
          severity: alertEvents.severity,
          delivered: alertEvents.delivered,
        })
        .from(alertEvents)
        .leftJoin(alertRules, eq(alertEvents.ruleId, alertRules.id))
        .where(conditions)
        .orderBy(desc(alertEvents.triggeredAt))
        .limit(req.query.limit);
      return rows.map((row) => ({
        id: row.id,
        rule_id: row.rule_id,
        rule_name: row.rule_name,
        rule_type: row.rule_type,
        triggered_at: row.triggered_at.toISOString(),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        severity: row.severity,
        delivered: row.delivered,
      }));
    },
  );
};

export default alertRulesRoutes;
