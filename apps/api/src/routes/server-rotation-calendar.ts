import {
  layers,
  matches,
  rotationProfiles,
  rotationSchedule,
  seedSchedule,
  servers,
} from '@squad/db/schema';
import { expandCron5Occurrences, isValidCron5 } from '@squad/shared-types';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { validateLayerName } from '../lib/rotation-segment.js';

const serverIdParams = z.object({ id: z.string().uuid() });
const entryParams = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });
const calendarQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const scheduleBody = z.object({
  scheduled_at: z.string().datetime(),
  layer: z.string().min(1).max(128),
  mode: z.enum(['set_next', 'force_change']).default('set_next'),
  enabled: z.boolean().optional(),
});
const scheduleUpdateBody = z
  .object({
    scheduled_at: z.string().datetime().optional(),
    layer: z.string().min(1).max(128).optional(),
    mode: z.enum(['set_next', 'force_change']).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
const profileInput = z.object({
  name: z.string().trim().min(1).max(64),
  weekday: z.number().int().min(0).max(6).nullable(),
  layers: z.array(z.string().min(1).max(128)).max(200),
});
const profilesBody = z.object({ profiles: z.array(profileInput).max(8) });

interface RotationScheduleOut {
  id: string;
  server_id: string;
  scheduled_at: string;
  layer: string;
  mode: 'set_next' | 'force_change';
  enabled: boolean;
  created_by: string | null;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RotationProfileOut {
  id: string;
  server_id: string;
  name: string;
  weekday: number | null;
  layers: string[];
  created_by: string | null;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

function serializeSchedule(row: typeof rotationSchedule.$inferSelect): RotationScheduleOut {
  return {
    id: row.id,
    server_id: row.serverId,
    scheduled_at: row.scheduledAt.toISOString(),
    layer: row.layer,
    mode: row.mode,
    enabled: row.enabled,
    created_by: row.createdBy,
    last_executed_at: row.lastExecutedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProfile(row: typeof rotationProfiles.$inferSelect): RotationProfileOut {
  return {
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    weekday: row.weekday,
    layers: row.layers,
    created_by: row.createdBy,
    last_applied_at: row.lastAppliedAt?.toISOString() ?? null,
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

function dateRange(query: z.infer<typeof calendarQuery>): { from: Date; to: Date } {
  const now = Date.now();
  return {
    from: query.from ? new Date(query.from) : new Date(now - 7 * 86_400_000),
    to: query.to ? new Date(query.to) : new Date(now + 30 * 86_400_000),
  };
}

async function knownLayerNames(app: Parameters<FastifyPluginAsync>[0], names: string[]) {
  if (names.length === 0) return new Set<string>();
  const rows = await app.db
    .select({ name: layers.name })
    .from(layers)
    .where(inArray(layers.name, names));
  return new Set(rows.map((row) => row.name));
}

interface RotationWarning {
  type: 'seed_schedule_overlap' | 'depot_update_window';
  message: string;
  seed_schedule_id?: string;
  seed_layer?: string;
  starts_at?: string;
}

async function scheduleWarnings(
  app: Parameters<FastifyPluginAsync>[0],
  serverId: string,
  scheduledAt: Date,
): Promise<RotationWarning[]> {
  const warnings: RotationWarning[] = [];
  const seedRows = await app.db
    .select()
    .from(seedSchedule)
    .where(and(eq(seedSchedule.serverId, serverId), eq(seedSchedule.enabled, true)));
  const from = new Date(scheduledAt.getTime() - 60 * 60_000);
  const to = new Date(scheduledAt.getTime() + 60 * 60_000);
  for (const seed of seedRows) {
    let conflict = false;
    let occurrence = seed.startsAt;
    if (seed.recurrence && isValidCron5(seed.recurrence)) {
      const scanFrom = new Date(Math.max(seed.startsAt.getTime(), from.getTime()));
      const occurrences =
        scanFrom <= to ? expandCron5Occurrences(seed.recurrence, scanFrom, to) : [];
      const matching = occurrences.find(
        (candidate) => Math.abs(candidate.getTime() - scheduledAt.getTime()) <= 60 * 60_000,
      );
      if (matching) occurrence = matching;
      conflict = matching !== undefined;
    } else {
      conflict = Math.abs(seed.startsAt.getTime() - scheduledAt.getTime()) <= 60 * 60_000;
    }
    if (conflict) {
      warnings.push({
        type: 'seed_schedule_overlap',
        message: `Пересечение с сид-стартом ${seed.seedLayer}`,
        seed_schedule_id: seed.id,
        seed_layer: seed.seedLayer,
        starts_at: occurrence.toISOString(),
      });
    }
  }
  if (await app.redis.get('depot:updating')) {
    warnings.push({
      type: 'depot_update_window',
      message: 'Сейчас выполняется обновление депо; смена будет повторена планировщиком позже.',
    });
  }
  return warnings;
}

/** ROT-4 calendar API: planned layer changes, match history, and weekly profiles. */
const serverRotationCalendarRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadServer(id: string) {
    return app.db.query.servers.findFirst({
      where: and(eq(servers.id, id), isNull(servers.deletedAt)),
    });
  }

  fast.get(
    '/api/v1/servers/:id/rotation-schedule',
    { config: { audit: false }, schema: { params: serverIdParams, querystring: calendarQuery } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      if (!(await loadServer(req.params.id))) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const range = dateRange(req.query);
      const [scheduleRows, historyRows, profileRows] = await Promise.all([
        app.db
          .select()
          .from(rotationSchedule)
          .where(eq(rotationSchedule.serverId, req.params.id))
          .orderBy(asc(rotationSchedule.scheduledAt)),
        app.db
          .select({
            id: matches.id,
            map: matches.map,
            layer: matches.layer,
            winner: matches.winner,
            isSeed: matches.isSeed,
            startedAt: matches.startedAt,
            endedAt: matches.endedAt,
            durationSeconds: matches.durationSeconds,
          })
          .from(matches)
          .where(
            and(
              eq(matches.serverId, req.params.id),
              gte(matches.startedAt, range.from),
              lte(matches.startedAt, range.to),
            ),
          )
          .orderBy(desc(matches.startedAt)),
        app.db
          .select()
          .from(rotationProfiles)
          .where(eq(rotationProfiles.serverId, req.params.id))
          .orderBy(asc(rotationProfiles.weekday), asc(rotationProfiles.name)),
      ]);
      const warningGroups = await Promise.all(
        scheduleRows.map(
          async (row) =>
            [row.id, await scheduleWarnings(app, row.serverId, row.scheduledAt)] as const,
        ),
      );
      return {
        entries: scheduleRows.map(serializeSchedule),
        history: historyRows.map((row) => ({
          id: row.id,
          map: row.map,
          layer: row.layer,
          winner: row.winner,
          is_seed: row.isSeed,
          started_at: row.startedAt.toISOString(),
          ended_at: row.endedAt?.toISOString() ?? null,
          duration_seconds: row.durationSeconds,
        })),
        profiles: profileRows.map(serializeProfile),
        warnings: Object.fromEntries(warningGroups),
        can_edit: req.user?.permissions.squadPermissions.has('changemap') ?? false,
      };
    },
  );

  fast.post(
    '/api/v1/servers/:id/rotation-schedule',
    { config: { audit: false }, schema: { params: serverIdParams, body: scheduleBody } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;
      if (!req.user) throw new Error('changemap guard did not establish a user');
      const actor = req.user;
      if (!(await loadServer(req.params.id))) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!validateLayerName(req.body.layer)) {
        reply.code(400);
        return { error: 'invalid_layer_name', layer: req.body.layer };
      }
      const known = await knownLayerNames(app, [req.body.layer]);
      if (!known.has(req.body.layer)) {
        reply.code(400);
        return { error: 'unknown_layer', layer: req.body.layer };
      }
      const [row] = await app.db
        .insert(rotationSchedule)
        .values({
          serverId: req.params.id,
          scheduledAt: new Date(req.body.scheduled_at),
          layer: req.body.layer,
          mode: req.body.mode,
          createdBy: actor.playerId,
          enabled: req.body.enabled ?? true,
        })
        .returning();
      if (!row) throw new Error('rotation_schedule insert returned no row');
      const warnings = await scheduleWarnings(app, req.params.id, row.scheduledAt);
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.rotation_schedule.create',
        targetType: 'rotation_schedule',
        targetId: row.id,
        after: serializeSchedule(row),
        context: { server_id: req.params.id, warnings },
        statusCode: reply.statusCode,
      });
      reply.code(201);
      return { ...serializeSchedule(row), warnings };
    },
  );

  fast.patch(
    '/api/v1/servers/:id/rotation-schedule/:entryId',
    { config: { audit: false }, schema: { params: entryParams, body: scheduleUpdateBody } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;
      if (!req.user) throw new Error('changemap guard did not establish a user');
      const actor = req.user;
      if (!(await loadServer(req.params.id))) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const existing = await app.db.query.rotationSchedule.findFirst({
        where: and(
          eq(rotationSchedule.id, req.params.entryId),
          eq(rotationSchedule.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (req.body.layer !== undefined) {
        if (!validateLayerName(req.body.layer)) {
          reply.code(400);
          return { error: 'invalid_layer_name', layer: req.body.layer };
        }
        const known = await knownLayerNames(app, [req.body.layer]);
        if (!known.has(req.body.layer)) {
          reply.code(400);
          return { error: 'unknown_layer', layer: req.body.layer };
        }
      }
      const updates: Partial<typeof rotationSchedule.$inferInsert> = { updatedAt: new Date() };
      if (req.body.scheduled_at !== undefined)
        updates.scheduledAt = new Date(req.body.scheduled_at);
      if (req.body.layer !== undefined) updates.layer = req.body.layer;
      if (req.body.mode !== undefined) updates.mode = req.body.mode;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      const [row] = await app.db
        .update(rotationSchedule)
        .set(updates)
        .where(eq(rotationSchedule.id, existing.id))
        .returning();
      if (!row) throw new Error('rotation_schedule update returned no row');
      const warnings = await scheduleWarnings(app, req.params.id, row.scheduledAt);
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.rotation_schedule.update',
        targetType: 'rotation_schedule',
        targetId: row.id,
        before: serializeSchedule(existing),
        after: serializeSchedule(row),
        context: { server_id: req.params.id, warnings },
        statusCode: reply.statusCode,
      });
      return { ...serializeSchedule(row), warnings };
    },
  );

  fast.delete(
    '/api/v1/servers/:id/rotation-schedule/:entryId',
    { config: { audit: false }, schema: { params: entryParams } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;
      if (!req.user) throw new Error('changemap guard did not establish a user');
      const actor = req.user;
      if (!(await loadServer(req.params.id))) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const existing = await app.db.query.rotationSchedule.findFirst({
        where: and(
          eq(rotationSchedule.id, req.params.entryId),
          eq(rotationSchedule.serverId, req.params.id),
        ),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'not_found' };
      }
      await app.db.delete(rotationSchedule).where(eq(rotationSchedule.id, existing.id));
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.rotation_schedule.delete',
        targetType: 'rotation_schedule',
        targetId: existing.id,
        before: serializeSchedule(existing),
        context: { server_id: req.params.id },
        statusCode: reply.statusCode,
      });
      return { deleted: true, id: existing.id };
    },
  );

  fast.put(
    '/api/v1/servers/:id/rotation-profiles',
    { config: { audit: false }, schema: { params: serverIdParams, body: profilesBody } },
    async (req, reply) => {
      const denied = changemapGuard(req, reply);
      if (denied) return denied;
      if (!req.user) throw new Error('changemap guard did not establish a user');
      const actor = req.user;
      if (!(await loadServer(req.params.id))) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const weekdays = req.body.profiles.map((profile) => profile.weekday);
      if (new Set(weekdays).size !== weekdays.length) {
        reply.code(400);
        return { error: 'duplicate_weekday' };
      }
      const names = req.body.profiles.map((profile) => profile.name.toLowerCase());
      if (new Set(names).size !== names.length) {
        reply.code(400);
        return { error: 'duplicate_profile_name' };
      }
      const allLayers = req.body.profiles.flatMap((profile) => profile.layers);
      for (const layer of allLayers) {
        if (!validateLayerName(layer)) {
          reply.code(400);
          return { error: 'invalid_layer_name', layer };
        }
      }
      const known = await knownLayerNames(app, allLayers);
      const unknown = allLayers.find((layer) => !known.has(layer));
      if (unknown) {
        reply.code(400);
        return { error: 'unknown_layer', layer: unknown };
      }
      const before = await app.db
        .select()
        .from(rotationProfiles)
        .where(eq(rotationProfiles.serverId, req.params.id));
      const after = await app.db.transaction(async (tx) => {
        await tx.delete(rotationProfiles).where(eq(rotationProfiles.serverId, req.params.id));
        if (req.body.profiles.length === 0) return [];
        return tx
          .insert(rotationProfiles)
          .values(
            req.body.profiles.map((profile) => ({
              serverId: req.params.id,
              name: profile.name,
              weekday: profile.weekday,
              layers: profile.layers,
              createdBy: actor.playerId,
            })),
          )
          .returning();
      });
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.rotation_profiles.replace',
        targetType: 'server',
        targetId: req.params.id,
        before: before.map(serializeProfile),
        after: after.map(serializeProfile),
        context: { server_id: req.params.id, profile_count: after.length },
        statusCode: reply.statusCode,
      });
      return { profiles: after.map(serializeProfile) };
    },
  );
};

export default serverRotationCalendarRoutes;
