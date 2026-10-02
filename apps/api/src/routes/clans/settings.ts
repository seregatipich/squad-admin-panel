import type { ClanRow } from '@squad/db/schema';
import { clanMembers, clans } from '@squad/db/schema';
import { isAdminsCfgSingleLineText } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { clanAccess } from '../../lib/clans/access.js';
import { clanIdParams, clanSnapshot, pgError, toClanDto } from '../../lib/clans/common.js';
import { auditRequestInTransaction } from '../../lib/request-audit.js';
import { requestUser } from '../../lib/request-user.js';

const NAME_MAX = 32;
const TAG_MAX = 32;
const TAGS_MAX = 16;
const DESCRIPTION_MAX = 2000;
const SLOTS_MAX = 999;

// Written into Admins.cfg as `// clan:<name>`, so it must stay on one line (#11).
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX)
  .refine(isAdminsCfgSingleLineText, { message: 'name_not_single_line' });
const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(TAG_MAX)
      .refine((tag) => !tag.includes(','), { message: 'tag_contains_comma' }),
  )
  .max(TAGS_MAX);
const slotsSchema = z.number().int().min(0).max(SLOTS_MAX);
const descriptionSchema = z.string().max(DESCRIPTION_MAX);

const createBody = z.object({
  name: nameSchema,
  description: descriptionSchema.nullish(),
  tags: tagsSchema.optional(),
  max_priority_slots: slotsSchema.optional(),
  primary_server_id: z.string().uuid().nullish(),
  is_public: z.boolean().optional(),
  is_tag_protected: z.boolean().optional(),
});

const updateBody = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    tags: tagsSchema.optional(),
    max_priority_slots: slotsSchema.optional(),
    primary_server_id: z.string().uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no_fields' });

const settingsBody = z
  .object({
    is_public: z.boolean().optional(),
    is_tag_protected: z.boolean().optional(),
  })
  .refine((body) => body.is_public !== undefined || body.is_tag_protected !== undefined, {
    message: 'no_fields',
  });

const expireBody = z.object({
  priority_expires_at: z.string().datetime({ offset: true }).nullable(),
});

/** Clan creation, editing, priority expiry and disbanding. */
const clanSettingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan, membershipRole } = clanAccess(app);

  fast.post(
    '/api/v1/clans',
    {
      schema: { body: createBody },
      config: { permissions: ['player:view'], audit: { action: 'clan.create', resource: 'clan' } },
    },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const id = uuidv7();
      let created: ClanRow;
      try {
        created = await app.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(clans)
            .values({
              id,
              name: req.body.name,
              description: req.body.description ?? null,
              tags: req.body.tags ?? [],
              maxPrioritySlots: req.body.max_priority_slots ?? 10,
              primaryServerId: req.body.primary_server_id ?? null,
              isPublic: req.body.is_public ?? false,
              isTagProtected: req.body.is_tag_protected ?? false,
            })
            .returning();
          if (!row) throw new Error('clans insert returned no row');
          req.auditSnapshots = { targetId: id, before: null, after: clanSnapshot(row) };
          reply.code(201);
          await auditRequestInTransaction(tx, req, reply);
          return row;
        });
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return {
            error: constraint === 'clans_name_active_key' ? 'clan_name_taken' : 'clan_tag_taken',
          };
        }
        if (code === '23503') {
          reply.code(400);
          return { error: 'invalid_primary_server' };
        }
        throw err;
      }
      reply.code(201);
      return toClanDto(created);
    },
  );

  fast.patch(
    '/api/v1/clans/:id',
    {
      schema: { params: clanIdParams, body: updateBody },
      config: { permissions: ['player:view'], audit: { action: 'clan.update', resource: 'clan' } },
    },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const body = req.body;
      const touchesPrivilegedField =
        body.name !== undefined ||
        body.tags !== undefined ||
        body.max_priority_slots !== undefined ||
        body.primary_server_id !== undefined;
      if (!user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, user.playerId);
        if (role !== 'leader' && role !== 'deputy') {
          reply.code(403);
          return { error: 'forbidden' };
        }
        if (touchesPrivilegedField) {
          reply.code(403);
          return { error: 'forbidden' };
        }
      }
      const before = clanSnapshot(clan);
      const updates: Partial<typeof clans.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;
      if (body.max_priority_slots !== undefined) updates.maxPrioritySlots = body.max_priority_slots;
      if (body.primary_server_id !== undefined) updates.primaryServerId = body.primary_server_id;
      let updated: ClanRow | undefined;
      try {
        updated = await app.db.transaction(async (tx) => {
          const [row] = await tx
            .update(clans)
            .set(updates)
            .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)))
            .returning();
          if (!row) return undefined;
          req.auditSnapshots = { targetId: clan.id, before, after: clanSnapshot(row) };
          await auditRequestInTransaction(tx, req, reply);
          return row;
        });
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return {
            error: constraint === 'clans_name_active_key' ? 'clan_name_taken' : 'clan_tag_taken',
          };
        }
        if (code === '23514') {
          reply.code(409);
          return { error: 'priority_capacity_exceeded' };
        }
        if (code === '23503') {
          reply.code(400);
          return { error: 'invalid_primary_server' };
        }
        throw err;
      }
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/settings',
    {
      schema: { params: clanIdParams, body: settingsBody },
      config: {
        permissions: ['player:view'],
        audit: { action: 'clan.settings.update', resource: 'clan' },
      },
    },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, user.playerId);
        if (role !== 'leader' && role !== 'deputy') {
          reply.code(403);
          return { error: 'forbidden' };
        }
      }
      const before = clanSnapshot(clan);
      const updates: Partial<typeof clans.$inferInsert> = { updatedAt: new Date() };
      if (req.body.is_public !== undefined) updates.isPublic = req.body.is_public;
      if (req.body.is_tag_protected !== undefined)
        updates.isTagProtected = req.body.is_tag_protected;
      const updated = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(clans)
          .set(updates)
          .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)))
          .returning();
        if (!row) return undefined;
        req.auditSnapshots = { targetId: clan.id, before, after: clanSnapshot(row) };
        await auditRequestInTransaction(tx, req, reply);
        return row;
      });
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/expire',
    {
      schema: { params: clanIdParams, body: expireBody },
      config: {
        permissions: ['player:view'],
        audit: { action: 'clan.expire.update', resource: 'clan' },
      },
    },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const before = clanSnapshot(clan);
      const expiresAt = req.body.priority_expires_at
        ? new Date(req.body.priority_expires_at)
        : null;
      const now = new Date();
      // Extending/clearing the deadline resets the expirer's processed flag
      // so priorities re-materialize on the next sync without any manual
      // toggling — see clan-priority-expirer/src/tick.ts.
      const resetsExpiry = expiresAt === null || expiresAt > now;
      const updated = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(clans)
          .set({
            priorityExpiresAt: expiresAt,
            updatedAt: now,
            ...(resetsExpiry ? { priorityExpiryProcessed: false } : {}),
          })
          .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)))
          .returning();
        if (!row) return undefined;
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'clan.expire.update',
          actor_player_id: user.playerId ?? null,
          enqueued_at: now.toISOString(),
          request_id: req.id,
        });
        req.auditSnapshots = { targetId: clan.id, before, after: clanSnapshot(row) };
        await auditRequestInTransaction(tx, req, reply);
        return row;
      });
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      return toClanDto(updated);
    },
  );

  fast.delete(
    '/api/v1/clans/:id',
    {
      schema: { params: clanIdParams },
      config: { permissions: ['player:view'], audit: { action: 'clan.disband', resource: 'clan' } },
    },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const disbandedAt = new Date();
      // The roster is deleted, not kept: clan_members_player_unique_idx is
      // global, so rows left behind a soft-deleted clan would bar its former
      // members from every other clan. The audit `before` snapshot keeps the
      // released roster. Soft-deleting the clan row first takes its row lock,
      // so a concurrent member add either commits before the roster delete or
      // sees the clan as deleted.
      await app.db.transaction(async (tx) => {
        const [after] = await tx
          .update(clans)
          .set({ deletedAt: disbandedAt, updatedAt: disbandedAt })
          .where(eq(clans.id, clan.id))
          .returning();
        const releasedMembers = await tx
          .delete(clanMembers)
          .where(eq(clanMembers.clanId, clan.id))
          .returning({
            player_id: clanMembers.playerId,
            member_role: clanMembers.memberRole,
            has_priority: clanMembers.hasPriority,
          });
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'clan.disband',
          actor_player_id: user.playerId ?? null,
          enqueued_at: disbandedAt.toISOString(),
          request_id: req.id,
        });
        req.auditSnapshots = {
          targetId: clan.id,
          before: { ...clanSnapshot(clan), members: releasedMembers },
          after: after ? clanSnapshot(after) : null,
        };
        await auditRequestInTransaction(tx, req, reply);
      });
      return { ok: true };
    },
  );
};

export default clanSettingsRoutes;
