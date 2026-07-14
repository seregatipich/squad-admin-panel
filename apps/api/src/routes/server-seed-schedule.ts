import { events, layers, seedSchedule, servers } from '@squad/db/schema';
import { isValidCron5 } from '@squad/shared-types';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const serverIdParams = z.object({ id: z.string().uuid() });
const entryParams = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });

const historyQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const createBody = z.object({
  starts_at: z.string().datetime(),
  seed_layer: z.string().min(1).max(128),
  broadcast_text: z.string().max(512).nullable().optional(),
  notify_minutes_before: z.number().int().min(0).max(1440).optional(),
  recurrence: z.string().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateBody = z
  .object({
    starts_at: z.string().datetime().optional(),
    seed_layer: z.string().min(1).max(128).optional(),
    broadcast_text: z.string().max(512).nullable().optional(),
    notify_minutes_before: z.number().int().min(0).max(1440).optional(),
    recurrence: z.string().min(1).max(64).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });

interface SeedScheduleEntryOut {
  id: string;
  server_id: string;
  starts_at: string;
  seed_layer: string;
  broadcast_text: string | null;
  notify_minutes_before: number;
  recurrence: string | null;
  enabled: boolean;
  created_by: string | null;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

function serialize(row: typeof seedSchedule.$inferSelect): SeedScheduleEntryOut {
  return {
    id: row.id,
    server_id: row.serverId,
    starts_at: row.startsAt.toISOString(),
    seed_layer: row.seedLayer,
    broadcast_text: row.broadcastText,
    notify_minutes_before: row.notifyMinutesBefore,
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

function changemapGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required_squad_permission?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.squadPermissions.has('changemap')) {
    reply.code(403);
    return { error: 'forbidden', required_squad_permission: 'changemap' };
  }
  return null;
}

interface SeedingWindow {
  started_at: string;
  ended_at: string | null;
  layer: string | null;
  player_count_at_start: number | null;
}

/**
 * Pairs `server.seeding_started`/`server.seeding_ended` event rows (SEED-1,
 * #140) into windows, ordered oldest-first. A `started` event with no
 * matching later `ended` event yields an open window (`ended_at: null`) —
 * the server is presumed still seeding as of the query.
 */
export function pairSeedingWindows(
  rows: { kind: string; occurredAt: Date; payload: unknown }[],
): SeedingWindow[] {
  const windows: SeedingWindow[] = [];
  let open: SeedingWindow | null = null;
  for (const row of rows) {
    const payload = (row.payload ?? {}) as { layer?: string | null; player_count?: number | null };
    if (row.kind === 'server.seeding_started') {
      if (open) windows.push(open);
      open = {
        started_at: row.occurredAt.toISOString(),
        ended_at: null,
        layer: payload.layer ?? null,
        player_count_at_start: payload.player_count ?? null,
      };
    } else if (row.kind === 'server.seeding_ended' && open) {
      open.ended_at = row.occurredAt.toISOString();
      windows.push(open);
      open = null;
    }
  }
  if (open) windows.push(open);
  return windows;
}

/**
 * SEED-3 (#142): CRUD for planned/recurring seed-layer starts
 * (`seed_schedule` table) plus a read-only history view of past seeding
 * windows derived from SEED-1's `server.seeding_started`/`server.seeding_ended`
 * event rows. Execution is performed out-of-band by
 * `@squad/worker-scheduler`'s `runSeedScheduleTick`
 * (`apps/workers/scheduler/src/seed-schedule-tick.ts`), not by this route.
 *
 * Read routes are gated on `panel_access` (report `can_edit` so the web
 * calendar can render read-only). Mutations are gated on the squad
 * permission `changemap`, mirroring the rotation editor (ROT-2).
 */
const serverSeedScheduleRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadServer(id: string) {
    return app.db.query.servers.findFirst({
      where: and(eq(servers.id, id), isNull(servers.deletedAt)),
    });
  }

  /** True when `name` is a catalog layer with `is_seed = true`. */
  async function isKnownSeedLayer(name: string): Promise<boolean> {
    const row = await app.db.query.layers.findFirst({
      where: and(eq(layers.name, name), eq(layers.isSeed, true)),
    });
    return row !== undefined;
  }

  fast.get(
    '/api/v1/servers/:id/seed-schedule',
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
        .from(seedSchedule)
        .where(eq(seedSchedule.serverId, req.params.id))
        .orderBy(asc(seedSchedule.startsAt));

      return {
        entries: rows.map(serialize),
        can_edit: req.user?.permissions.squadPermissions.has('changemap') ?? false,
      };
    },
  );

  fast.get(
    '/api/v1/servers/:id/seed-schedule/history',
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
      const startedRows = await app.db
        .select({ kind: events.kind, occurredAt: events.occurredAt, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.serverId, req.params.id),
            eq(events.kind, 'server.seeding_started'),
            ...(from ? [gte(events.occurredAt, from)] : []),
            ...(to ? [lte(events.occurredAt, to)] : []),
          ),
        );
      const endedRows = await app.db
        .select({ kind: events.kind, occurredAt: events.occurredAt, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.serverId, req.params.id),
            eq(events.kind, 'server.seeding_ended'),
            ...(from ? [gte(events.occurredAt, from)] : []),
            ...(to ? [lte(events.occurredAt, to)] : []),
          ),
        );

      const merged = [...startedRows, ...endedRows].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      );

      return { windows: pairSeedingWindows(merged) };
    },
  );

  fast.post(
    '/api/v1/servers/:id/seed-schedule',
    { config: { audit: false }, schema: { params: serverIdParams, body: createBody } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      if (!(await isKnownSeedLayer(req.body.seed_layer))) {
        reply.code(400);
        return { error: 'invalid_seed_layer', seed_layer: req.body.seed_layer };
      }
      if (req.body.recurrence != null && !isValidCron5(req.body.recurrence)) {
        reply.code(400);
        return { error: 'invalid_recurrence', recurrence: req.body.recurrence };
      }

      const [row] = await app.db
        .insert(seedSchedule)
        .values({
          serverId: req.params.id,
          startsAt: new Date(req.body.starts_at),
          seedLayer: req.body.seed_layer,
          broadcastText: req.body.broadcast_text ?? null,
          notifyMinutesBefore: req.body.notify_minutes_before ?? 0,
          recurrence: req.body.recurrence ?? null,
          createdBy: req.user?.playerId ?? null,
          enabled: req.body.enabled ?? true,
        })
        .returning();
      if (!row) throw new Error('seed_schedule insert returned no row');

      // biome-ignore lint/style/noNonNullAssertion: changemapGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.seed_schedule.create',
        targetType: 'seed_schedule',
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
    '/api/v1/servers/:id/seed-schedule/:entryId',
    { config: { audit: false }, schema: { params: entryParams, body: updateBody } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const existing = await app.db.query.seedSchedule.findFirst({
        where: and(
          eq(seedSchedule.id, req.params.entryId),
          eq(seedSchedule.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }

      if (req.body.seed_layer !== undefined && !(await isKnownSeedLayer(req.body.seed_layer))) {
        reply.code(400);
        return { error: 'invalid_seed_layer', seed_layer: req.body.seed_layer };
      }
      if (req.body.recurrence != null && !isValidCron5(req.body.recurrence)) {
        reply.code(400);
        return { error: 'invalid_recurrence', recurrence: req.body.recurrence };
      }

      const updateSet: Partial<typeof seedSchedule.$inferInsert> = { updatedAt: new Date() };
      if (req.body.starts_at !== undefined) updateSet.startsAt = new Date(req.body.starts_at);
      if (req.body.seed_layer !== undefined) updateSet.seedLayer = req.body.seed_layer;
      if (req.body.broadcast_text !== undefined) updateSet.broadcastText = req.body.broadcast_text;
      if (req.body.notify_minutes_before !== undefined) {
        updateSet.notifyMinutesBefore = req.body.notify_minutes_before;
      }
      if (req.body.recurrence !== undefined) updateSet.recurrence = req.body.recurrence;
      if (req.body.enabled !== undefined) updateSet.enabled = req.body.enabled;

      const [row] = await app.db
        .update(seedSchedule)
        .set(updateSet)
        .where(eq(seedSchedule.id, req.params.entryId))
        .returning();
      if (!row) throw new Error('seed_schedule update returned no row');

      // biome-ignore lint/style/noNonNullAssertion: changemapGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.seed_schedule.update',
        targetType: 'seed_schedule',
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
    '/api/v1/servers/:id/seed-schedule/:entryId',
    { config: { audit: false }, schema: { params: entryParams } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;

      const server = await loadServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const existing = await app.db.query.seedSchedule.findFirst({
        where: and(
          eq(seedSchedule.id, req.params.entryId),
          eq(seedSchedule.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }

      await app.db.delete(seedSchedule).where(eq(seedSchedule.id, req.params.entryId));

      // biome-ignore lint/style/noNonNullAssertion: changemapGuard above requires req.user
      const user = req.user!;
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.seed_schedule.delete',
        targetType: 'seed_schedule',
        targetId: existing.id,
        before: serialize(existing),
        context: { server_id: req.params.id },
        statusCode: reply.statusCode,
      });

      return { deleted: true, id: existing.id };
    },
  );
};

export default serverSeedScheduleRoutes;
