import {
  layers,
  type ScheduledTaskParams,
  type ScheduledTaskType,
  scheduledTaskRuns,
  scheduledTasks,
  servers,
} from '@squad/db/schema';
import { isValidCron5 } from '@squad/shared-types';
import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const serverIdParams = z.object({ id: z.string().uuid() });
const taskParams = z.object({ id: z.string().uuid(), taskId: z.string().uuid() });

const historyQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const taskTypeSchema = z.enum(['restart', 'set_next_layer', 'change_layer', 'broadcast']);
const paramsSchema = z.object({
  layer: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(512).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(128),
  task_type: taskTypeSchema,
  params: paramsSchema.optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  recurrence: z.string().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateBody = z
  .object({
    name: z.string().min(1).max(128).optional(),
    params: paramsSchema.optional(),
    scheduled_at: z.string().datetime().nullable().optional(),
    recurrence: z.string().min(1).max(64).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });

interface ScheduledTaskOut {
  id: string;
  server_id: string;
  name: string;
  task_type: ScheduledTaskType;
  params: ScheduledTaskParams;
  scheduled_at: string | null;
  recurrence: string | null;
  enabled: boolean;
  created_by: string | null;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

function serialize(row: typeof scheduledTasks.$inferSelect): ScheduledTaskOut {
  return {
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    task_type: row.taskType,
    params: row.params ?? {},
    scheduled_at: row.scheduledAt?.toISOString() ?? null,
    recurrence: row.recurrence,
    enabled: row.enabled,
    created_by: row.createdBy,
    last_executed_at: row.lastExecutedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
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

/**
 * Enforces the permission a given `task_type` requires: `restart` reuses the
 * SRV-3 `server:restart` panel permission (the same guard as
 * `POST /api/v1/servers/:id/restart`); `set_next_layer`/`change_layer` reuse
 * the `changemap` squad permission (as the rotation editors do); `broadcast`
 * reuses the `chat` squad permission (as the messaging route does).
 */
function taskTypeGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  taskType: ScheduledTaskType,
): { error: string; required_permission?: string; required_squad_permission?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (taskType === 'restart') {
    if (!req.user.permissions.permissions.has('server:restart')) {
      reply.code(403);
      return { error: 'forbidden', required_permission: 'server:restart' };
    }
    return null;
  }
  const squadPermission = taskType === 'broadcast' ? 'chat' : 'changemap';
  if (!req.user.permissions.squadPermissions.has(squadPermission)) {
    reply.code(403);
    return { error: 'forbidden', required_squad_permission: squadPermission };
  }
  return null;
}

/**
 * AUTO-2 (#73): CRUD plus a read-only execution history for the general
 * `scheduled_tasks` table — server actions (restart, `set_next_layer` /
 * `change_layer`, broadcast) run on a one-off `scheduled_at` instant or a
 * recurring 5-field cron `recurrence`. Execution is performed out-of-band by
 * `@squad/worker-scheduler`'s `runScheduledTaskTick`
 * (`apps/workers/scheduler/src/scheduled-task-tick.ts`), not by this route,
 * which only manages task definitions and surfaces their run history.
 *
 * Reads are gated on `panel_access`; the list response reports per-type
 * `capabilities` so the web can hide actions the caller may not schedule.
 * Mutations are gated per `task_type` — see {@link taskTypeGuard}.
 */
const serverScheduledTasksRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadServer(id: string) {
    return app.db.query.servers.findFirst({
      where: and(eq(servers.id, id), isNull(servers.deletedAt)),
    });
  }

  /** True when `name` is a layer in the catalog. */
  async function isKnownLayer(name: string): Promise<boolean> {
    const rows = await app.db
      .select({ name: layers.name })
      .from(layers)
      .where(inArray(layers.name, [name]));
    return rows.length > 0;
  }

  /**
   * Validates + normalizes `params` for the given task type. Returns the
   * params to store, or an `{ error }` when a required value is missing/unknown.
   */
  async function resolveParams(
    taskType: ScheduledTaskType,
    params: ScheduledTaskParams | undefined,
  ): Promise<{ value: ScheduledTaskParams } | { error: 'invalid_params' | 'unknown_layer' }> {
    switch (taskType) {
      case 'restart':
        return { value: {} };
      case 'set_next_layer':
      case 'change_layer': {
        const layer = params?.layer;
        if (!layer) return { error: 'invalid_params' };
        if (!(await isKnownLayer(layer))) return { error: 'unknown_layer' };
        return { value: { layer } };
      }
      case 'broadcast': {
        const message = params?.message;
        if (!message) return { error: 'invalid_params' };
        return { value: { message } };
      }
    }
  }

  fast.get(
    '/api/v1/servers/:id/scheduled-tasks',
    { config: { audit: false }, schema: { params: serverIdParams } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const rows = await app.db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.serverId, req.params.id))
        .orderBy(desc(scheduledTasks.createdAt));

      const panelPermissions = req.user?.permissions.permissions;
      const squadPermissions = req.user?.permissions.squadPermissions;
      return {
        tasks: rows.map(serialize),
        capabilities: {
          restart: panelPermissions?.has('server:restart') ?? false,
          set_next_layer: squadPermissions?.has('changemap') ?? false,
          change_layer: squadPermissions?.has('changemap') ?? false,
          broadcast: squadPermissions?.has('chat') ?? false,
        },
      };
    },
  );

  fast.get(
    '/api/v1/servers/:id/scheduled-tasks/history',
    { config: { audit: false }, schema: { params: serverIdParams, querystring: historyQuery } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      const rows = await app.db
        .select({
          id: scheduledTaskRuns.id,
          taskId: scheduledTaskRuns.taskId,
          taskName: scheduledTasks.name,
          taskType: scheduledTasks.taskType,
          executedAt: scheduledTaskRuns.executedAt,
          status: scheduledTaskRuns.status,
          detail: scheduledTaskRuns.detail,
        })
        .from(scheduledTaskRuns)
        .innerJoin(scheduledTasks, eq(scheduledTasks.id, scheduledTaskRuns.taskId))
        .where(
          and(
            eq(scheduledTasks.serverId, req.params.id),
            ...(from ? [gte(scheduledTaskRuns.executedAt, from)] : []),
            ...(to ? [lte(scheduledTaskRuns.executedAt, to)] : []),
          ),
        )
        .orderBy(desc(scheduledTaskRuns.executedAt))
        .limit(req.query.limit ?? 100);

      return {
        runs: rows.map((row) => ({
          id: row.id,
          task_id: row.taskId,
          task_name: row.taskName,
          task_type: row.taskType,
          executed_at: row.executedAt.toISOString(),
          status: row.status,
          detail: row.detail ?? {},
        })),
      };
    },
  );

  fast.post(
    '/api/v1/servers/:id/scheduled-tasks',
    { config: { audit: false }, schema: { params: serverIdParams, body: createBody } },
    async (req, reply) => {
      const denied = taskTypeGuard(req, reply, req.body.task_type);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const scheduledAt = req.body.scheduled_at ?? null;
      const recurrence = req.body.recurrence ?? null;
      if (scheduledAt === null && recurrence === null) {
        reply.code(400);
        return { error: 'missing_schedule' };
      }
      if (recurrence !== null && !isValidCron5(recurrence)) {
        reply.code(400);
        return { error: 'invalid_recurrence', recurrence };
      }
      const resolvedParams = await resolveParams(req.body.task_type, req.body.params);
      if ('error' in resolvedParams) {
        reply.code(400);
        return { error: resolvedParams.error };
      }

      const [row] = await app.db
        .insert(scheduledTasks)
        .values({
          serverId: req.params.id,
          name: req.body.name,
          taskType: req.body.task_type,
          params: resolvedParams.value,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          recurrence,
          enabled: req.body.enabled ?? true,
          createdBy: req.user?.playerId ?? null,
        })
        .returning();
      if (!row) throw new Error('scheduled_tasks insert returned no row');

      // biome-ignore lint/style/noNonNullAssertion: taskTypeGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.scheduled_task.create',
        targetType: 'scheduled_task',
        targetId: row.id,
        after: serialize(row),
        context: { server_id: req.params.id },
        statusCode: reply.statusCode,
      });

      reply.code(201);
      return serialize(row);
    },
  );

  fast.patch(
    '/api/v1/servers/:id/scheduled-tasks/:taskId',
    { config: { audit: false }, schema: { params: taskParams, body: updateBody } },
    async (req, reply) => {
      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const existing = await app.db.query.scheduledTasks.findFirst({
        where: and(
          eq(scheduledTasks.id, req.params.taskId),
          eq(scheduledTasks.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const denied = taskTypeGuard(req, reply, existing.taskType);
      if (denied) return denied;

      const nextScheduledAt =
        req.body.scheduled_at !== undefined
          ? req.body.scheduled_at
          : (existing.scheduledAt?.toISOString() ?? null);
      const nextRecurrence =
        req.body.recurrence !== undefined ? req.body.recurrence : existing.recurrence;
      if (nextScheduledAt === null && nextRecurrence === null) {
        reply.code(400);
        return { error: 'missing_schedule' };
      }
      if (
        req.body.recurrence !== undefined &&
        req.body.recurrence !== null &&
        !isValidCron5(req.body.recurrence)
      ) {
        reply.code(400);
        return { error: 'invalid_recurrence', recurrence: req.body.recurrence };
      }

      const updateSet: Partial<typeof scheduledTasks.$inferInsert> = { updatedAt: new Date() };
      if (req.body.name !== undefined) updateSet.name = req.body.name;
      if (req.body.params !== undefined) {
        const resolvedParams = await resolveParams(existing.taskType, req.body.params);
        if ('error' in resolvedParams) {
          reply.code(400);
          return { error: resolvedParams.error };
        }
        updateSet.params = resolvedParams.value;
      }
      if (req.body.scheduled_at !== undefined) {
        updateSet.scheduledAt = req.body.scheduled_at ? new Date(req.body.scheduled_at) : null;
      }
      if (req.body.recurrence !== undefined) updateSet.recurrence = req.body.recurrence;
      if (req.body.enabled !== undefined) updateSet.enabled = req.body.enabled;

      const [row] = await app.db
        .update(scheduledTasks)
        .set(updateSet)
        .where(eq(scheduledTasks.id, req.params.taskId))
        .returning();
      if (!row) throw new Error('scheduled_tasks update returned no row');

      // biome-ignore lint/style/noNonNullAssertion: taskTypeGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.scheduled_task.update',
        targetType: 'scheduled_task',
        targetId: row.id,
        before: serialize(existing),
        after: serialize(row),
        context: { server_id: req.params.id },
        statusCode: reply.statusCode,
      });

      return serialize(row);
    },
  );

  fast.delete(
    '/api/v1/servers/:id/scheduled-tasks/:taskId',
    { config: { audit: false }, schema: { params: taskParams } },
    async (req, reply) => {
      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const existing = await app.db.query.scheduledTasks.findFirst({
        where: and(
          eq(scheduledTasks.id, req.params.taskId),
          eq(scheduledTasks.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const denied = taskTypeGuard(req, reply, existing.taskType);
      if (denied) return denied;

      await app.db.delete(scheduledTasks).where(eq(scheduledTasks.id, req.params.taskId));

      // biome-ignore lint/style/noNonNullAssertion: taskTypeGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.scheduled_task.delete',
        targetType: 'scheduled_task',
        targetId: existing.id,
        before: serialize(existing),
        context: { server_id: req.params.id },
        statusCode: reply.statusCode,
      });

      return { deleted: true, id: existing.id };
    },
  );
};

export default serverScheduledTasksRoutes;
