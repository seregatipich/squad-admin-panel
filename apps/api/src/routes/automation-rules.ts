import { type AutomationRuleRow, automationRules, automationRuns, servers } from '@squad/db/schema';
import type { PermissionKey, SquadPermissionKey } from '@squad/shared-config';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_CONDITION_TYPES,
  type AutomationActionType,
  type AutomationConditionType,
  type AutomationMatch,
  type AutomationRuleInput,
  evaluate,
  parseAutomationAction,
  parseAutomationCondition,
  type RconOperatorCommandName,
  type RunMatchDeps,
  rconCommandActionSchema,
  runMatch,
} from '@squad/shared-types';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

const configObject = z.record(z.unknown());

const conditionTypeEnum = z.enum(AUTOMATION_CONDITION_TYPES);
const actionTypeEnum = z.enum(AUTOMATION_ACTION_TYPES);

function validateConfigs(
  value: {
    conditionType: AutomationConditionType;
    condition: unknown;
    actionType: AutomationActionType;
    action: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const condition = parseAutomationCondition(value.conditionType, value.condition);
  if (!condition.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['condition'],
      message: `invalid condition for ${value.conditionType}: ${condition.error.issues[0]?.message ?? 'invalid'}`,
    });
  }
  const action = parseAutomationAction(value.actionType, value.action);
  if (!action.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message: `invalid action for ${value.actionType}: ${action.error.issues[0]?.message ?? 'invalid'}`,
    });
  }
}

const createBody = z
  .object({
    name: z.string().trim().min(1).max(128),
    server_id: z.string().uuid().nullable().default(null),
    condition_type: conditionTypeEnum,
    condition: configObject.default({}),
    action_type: actionTypeEnum,
    action: configObject.default({}),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) =>
    validateConfigs(
      {
        conditionType: value.condition_type,
        condition: value.condition,
        actionType: value.action_type,
        action: value.action,
      },
      ctx,
    ),
  );

const idParam = z.object({ id: z.string().uuid() });

const dryRunBody = z.object({
  sample: z
    .object({
      chat_message: z.string().max(512).optional(),
      player_count: z.number().int().min(0).max(500).optional(),
      player_flags: z.array(z.string().max(64)).max(32).optional(),
      now: z.string().datetime().optional(),
      player: z
        .object({
          player_id: z.string().uuid().nullable().optional(),
          steam_id64: z.string().max(20).nullable().optional(),
          eos_id: z.string().max(64).nullable().optional(),
          name: z.string().max(128).nullable().optional(),
        })
        .optional(),
    })
    .default({}),
});

const runsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  rule_id: z.string().uuid().optional(),
});

function serializeRule(row: AutomationRuleRow) {
  return {
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    condition_type: row.conditionType,
    condition: (row.condition ?? {}) as Record<string, unknown>,
    action_type: row.actionType,
    action: (row.action ?? {}) as Record<string, unknown>,
    enabled: row.enabled,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toRuleInput(row: AutomationRuleRow): AutomationRuleInput {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    conditionType: row.conditionType,
    condition: row.condition,
    actionType: row.actionType,
    action: row.action,
    enabled: row.enabled,
  };
}

/**
 * Live-Squad rights an RCON command needs when a panel operator sends it by
 * hand (mirrors `requireChangemap`, `server-messaging.ts` and
 * `server-seeding.ts`). Squad rights have no catalogue key, so they are
 * reported as `squad:<key>` in a 403's `required` list.
 */
const RCON_COMMAND_REQUIREMENTS: Record<
  RconOperatorCommandName,
  { permission: PermissionKey } | { squad: SquadPermissionKey }
> = {
  AdminBan: { permission: 'mod:ban_perm' },
  AdminKick: { permission: 'mod:kick' },
  AdminWarn: { permission: 'mod:warn' },
  AdminBroadcast: { squad: 'chat' },
  AdminChangeLayer: { squad: 'changemap' },
  AdminSetNextLayer: { squad: 'changemap' },
  AdminEndMatch: { squad: 'changemap' },
  AdminReloadServerConfig: { squad: 'manageserver' },
};

/**
 * Rights missing for the caller to plan a rule's action (#111). A rule runs
 * its action as the system actor on every matching server, so `trigger:edit`
 * alone must not let a caller schedule a ban, kick or map change they could
 * not perform themselves.
 *
 * @param req - the authenticated request (the global auth hook has run).
 * @param actionType - the rule's action type.
 * @param action - the rule's (already validated) action config.
 * @returns the missing rights; empty when the caller may plan the action.
 */
function missingActionRights(
  req: FastifyRequest,
  actionType: AutomationActionType,
  action: unknown,
): string[] {
  const context = req.user?.permissions;
  if (!context) return ['unauthenticated'];
  const needs = (key: PermissionKey): string[] => (context.permissions.has(key) ? [] : [key]);
  switch (actionType) {
    case 'kick':
      return needs('mod:kick');
    case 'warn':
      return needs('mod:warn');
    case 'notify_admin':
      return [];
    case 'rcon_command': {
      const parsed = rconCommandActionSchema.safeParse(action);
      if (!parsed.success) return [];
      const requirement = RCON_COMMAND_REQUIREMENTS[parsed.data.command];
      if ('permission' in requirement) return needs(requirement.permission);
      return context.squadPermissions.has(requirement.squad) ? [] : [`squad:${requirement.squad}`];
    }
  }
}

/** True for a Postgres foreign-key violation (SQLSTATE 23503), bare or drizzle-wrapped. */
function isForeignKeyViolation(err: unknown): boolean {
  const code =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return code === '23503';
}

const automationRulesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /** False when `serverId` names no server (a null id is a global rule). */
  async function serverExists(serverId: string | null): Promise<boolean> {
    if (serverId === null) return true;
    const [row] = await app.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return row !== undefined;
  }

  fast.get(
    '/api/v1/automation-rules',
    { config: { permissions: ['trigger:view'], audit: false } },
    async () => {
      const rows = await app.db
        .select()
        .from(automationRules)
        .orderBy(desc(automationRules.createdAt));
      return rows.map(serializeRule);
    },
  );

  fast.post(
    '/api/v1/automation-rules',
    {
      schema: { body: createBody },
      config: {
        permissions: ['trigger:edit'],
        audit: { action: 'automation_rule.create', resource: 'automation_rule' },
      },
    },
    async (req, reply) => {
      const required = missingActionRights(req, req.body.action_type, req.body.action);
      if (required.length > 0) {
        reply.code(403);
        return { error: 'forbidden', required };
      }
      if (!(await serverExists(req.body.server_id))) {
        reply.code(404);
        return { error: 'server_not_found' };
      }
      const id = uuidv7();
      let row: AutomationRuleRow | undefined;
      try {
        [row] = await app.db
          .insert(automationRules)
          .values({
            id,
            serverId: req.body.server_id,
            name: req.body.name,
            conditionType: req.body.condition_type,
            condition: req.body.condition,
            actionType: req.body.action_type,
            action: req.body.action,
            enabled: req.body.enabled,
            createdBy: req.user?.playerId ?? null,
          })
          .returning();
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err;
        reply.code(404);
        return { error: 'server_not_found' };
      }
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      req.auditSnapshots = { before: null, after: serializeRule(row), targetId: row.id };
      reply.code(201);
      return serializeRule(row);
    },
  );

  fast.put(
    '/api/v1/automation-rules/:id',
    {
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(128).optional(),
            server_id: z.string().uuid().nullable().optional(),
            condition: configObject.optional(),
            action: configObject.optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      },
      config: {
        permissions: ['trigger:edit'],
        audit: { action: 'automation_rule.update', resource: 'automation_rule' },
      },
    },
    async (req, reply) => {
      const [current] = await app.db
        .select()
        .from(automationRules)
        .where(eq(automationRules.id, req.params.id))
        .limit(1);
      if (!current) {
        reply.code(404);
        return { error: 'automation_rule_not_found' };
      }

      if (req.body.condition !== undefined) {
        const parsed = parseAutomationCondition(current.conditionType, req.body.condition);
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_condition', detail: parsed.error.issues[0]?.message };
        }
      }
      if (req.body.action !== undefined) {
        const parsed = parseAutomationAction(current.actionType, req.body.action);
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_action', detail: parsed.error.issues[0]?.message };
        }
      }
      const required = missingActionRights(
        req,
        current.actionType,
        req.body.action ?? current.action,
      );
      if (required.length > 0) {
        reply.code(403);
        return { error: 'forbidden', required };
      }
      if (req.body.server_id !== undefined && !(await serverExists(req.body.server_id))) {
        reply.code(404);
        return { error: 'server_not_found' };
      }

      const updates: Partial<typeof automationRules.$inferInsert> = { updatedAt: new Date() };
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.server_id !== undefined) updates.serverId = req.body.server_id;
      if (req.body.condition !== undefined) updates.condition = req.body.condition;
      if (req.body.action !== undefined) updates.action = req.body.action;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      let row: AutomationRuleRow | undefined;
      try {
        [row] = await app.db
          .update(automationRules)
          .set(updates)
          .where(eq(automationRules.id, req.params.id))
          .returning();
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err;
        reply.code(404);
        return { error: 'server_not_found' };
      }
      if (!row) {
        reply.code(404);
        return { error: 'automation_rule_not_found' };
      }
      req.auditSnapshots = { before: serializeRule(current), after: serializeRule(row) };
      return serializeRule(row);
    },
  );

  fast.delete(
    '/api/v1/automation-rules/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: ['trigger:edit'],
        audit: { action: 'automation_rule.delete', resource: 'automation_rule' },
      },
    },
    async (req, reply) => {
      const [deleted] = await app.db
        .delete(automationRules)
        .where(eq(automationRules.id, req.params.id))
        .returning();
      if (!deleted) {
        reply.code(404);
        return { error: 'automation_rule_not_found' };
      }
      req.auditSnapshots = { before: serializeRule(deleted), after: null };
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/automation-rules/:id/dry-run',
    {
      schema: { params: idParam, body: dryRunBody },
      config: {
        permissions: ['trigger:edit'],
        audit: { action: 'automation_rule.dry_run', resource: 'automation_rule' },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(automationRules)
        .where(eq(automationRules.id, req.params.id))
        .limit(1);
      if (!row) {
        reply.code(404);
        return { error: 'automation_rule_not_found' };
      }

      const sample = req.body.sample;
      const player = sample.player
        ? {
            playerId: sample.player.player_id ?? null,
            steamId64: sample.player.steam_id64 ?? null,
            eosId: sample.player.eos_id ?? null,
            name: sample.player.name ?? null,
          }
        : null;
      const input = {
        serverId: row.serverId,
        now: sample.now ? new Date(sample.now) : new Date(),
        chatMessage: sample.chat_message ?? null,
        playerCount: sample.player_count ?? null,
        playerFlags: sample.player_flags ?? null,
        player,
      };

      // Evaluate ONLY this rule, forcing enabled so a disabled draft can be tested.
      const matches = evaluate(input, [{ ...toRuleInput(row), enabled: true }]);

      // Dry-run deps: runMatch's dry-run guard never dispatches, and the API
      // deliberately holds no path onto worker-rcon's stream (#109) — should
      // that guard ever regress, the dry-run fails loudly instead of sending a
      // real AdminBan/AdminEndMatch. writeAudit is a no-op here because the
      // route-level config.audit already records the dry-run.
      const deps: RunMatchDeps = {
        enqueueRcon: async () => {
          throw new Error('enqueueRcon must not be called in dry-run');
        },
        notifyAdmin: async () => ({ delivered: false, detail: { dryRun: true } }),
        recordRun: async (draft) => {
          await app.db.insert(automationRuns).values({
            ruleId: draft.ruleId,
            serverId: draft.serverId,
            matched: draft.matched,
            actionResult: draft.actionResult,
            dryRun: draft.dryRun,
            status: draft.status,
          });
        },
        writeAudit: async () => {},
      };

      if (matches.length === 0) {
        await app.db.insert(automationRuns).values({
          ruleId: row.id,
          serverId: row.serverId,
          matched: {},
          actionResult: { matched: false },
          dryRun: true,
          status: 'no_match',
        });
        return { matched: false, rule_id: row.id, runs: [] as unknown[] };
      }

      const drafts = [] as Array<{ status: string; action_result: Record<string, unknown> | null }>;
      for (const match of matches as AutomationMatch[]) {
        const draft = await runMatch(deps, match, { dryRun: true });
        drafts.push({ status: draft.status, action_result: draft.actionResult });
      }
      return { matched: true, rule_id: row.id, runs: drafts };
    },
  );

  fast.get(
    '/api/v1/automation-runs',
    { schema: { querystring: runsQuery }, config: { permissions: ['trigger:view'], audit: false } },
    async (req) => {
      const conditions = req.query.rule_id
        ? eq(automationRuns.ruleId, req.query.rule_id)
        : undefined;
      const rows = await app.db
        .select({
          id: automationRuns.id,
          rule_id: automationRuns.ruleId,
          rule_name: automationRules.name,
          condition_type: automationRules.conditionType,
          action_type: automationRules.actionType,
          server_id: automationRuns.serverId,
          fired_at: automationRuns.firedAt,
          matched: automationRuns.matched,
          action_result: automationRuns.actionResult,
          dry_run: automationRuns.dryRun,
          status: automationRuns.status,
        })
        .from(automationRuns)
        .leftJoin(automationRules, eq(automationRuns.ruleId, automationRules.id))
        .where(conditions)
        .orderBy(desc(automationRuns.firedAt))
        .limit(req.query.limit);
      return rows.map((run) => ({
        id: run.id,
        rule_id: run.rule_id,
        rule_name: run.rule_name,
        condition_type: run.condition_type,
        action_type: run.action_type,
        server_id: run.server_id,
        fired_at: run.fired_at.toISOString(),
        matched: (run.matched ?? {}) as Record<string, unknown>,
        action_result: (run.action_result ?? null) as Record<string, unknown> | null,
        dry_run: run.dry_run,
        status: run.status,
      }));
    },
  );
};

export default automationRulesRoutes;
