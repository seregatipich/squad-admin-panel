import type { ClanRow } from '@squad/db/schema';
import { clanMembers, clans, playerSessions, players, servers } from '@squad/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const NAME_MAX = 32;
const TAG_MAX = 32;
const TAGS_MAX = 16;
const DESCRIPTION_MAX = 2000;
const SLOTS_MAX = 999;

const clanIdParams = z.object({ id: z.string().uuid() });

const nameSchema = z.string().trim().min(1).max(NAME_MAX);
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

function clanSnapshot(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function toClanDto(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const wrapped = err as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  return {
    code: wrapped.code ?? wrapped.cause?.code,
    constraint: wrapped.constraint_name ?? wrapped.cause?.constraint_name,
  };
}

function auditActor(req: FastifyRequest) {
  if (!req.user) throw new Error('audit actor requires an authenticated user');
  return { kind: 'steam' as const, playerId: req.user.playerId, tokenId: req.apiTokenId ?? null };
}

const clansRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadActiveClan(id: string): Promise<ClanRow | null> {
    const rows = await app.db
      .select()
      .from(clans)
      .where(and(eq(clans.id, id), isNull(clans.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function membershipRole(clanId: string, playerId: string): Promise<string | null> {
    const rows = await app.db
      .select({ role: clanMembers.memberRole })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clanId), eq(clanMembers.playerId, playerId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  fast.get('/api/v1/clans', { config: { audit: false } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    const rows = await app.db
      .select({
        id: clans.id,
        name: clans.name,
        tags: clans.tags,
        description: clans.description,
        maxPrioritySlots: clans.maxPrioritySlots,
        priorityExpiresAt: clans.priorityExpiresAt,
        isTagProtected: clans.isTagProtected,
        isPublic: clans.isPublic,
        primaryServerId: clans.primaryServerId,
        createdAt: clans.createdAt,
        updatedAt: clans.updatedAt,
        memberCount: sql<number>`(SELECT count(*) FROM clan_members m WHERE m.clan_id = ${clans.id})`,
        priorityCount: sql<number>`(SELECT count(*) FROM clan_members m WHERE m.clan_id = ${clans.id} AND m.has_priority)`,
      })
      .from(clans)
      .where(isNull(clans.deletedAt))
      .orderBy(asc(clans.name));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        tags: r.tags,
        description: r.description,
        max_priority_slots: r.maxPrioritySlots,
        priority_expires_at: r.priorityExpiresAt ? r.priorityExpiresAt.toISOString() : null,
        is_tag_protected: r.isTagProtected,
        is_public: r.isPublic,
        primary_server_id: r.primaryServerId,
        member_count: Number(r.memberCount),
        priority_count: Number(r.priorityCount),
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      })),
      total: rows.length,
    };
  });

  fast.get(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const members = await app.db
        .select({
          playerId: clanMembers.playerId,
          memberRole: clanMembers.memberRole,
          hasPriority: clanMembers.hasPriority,
          joinedAt: clanMembers.joinedAt,
          canonicalName: players.canonicalName,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt));
      return {
        ...toClanDto(clan),
        members: members.map((m) => ({
          player_id: m.playerId,
          canonical_name: m.canonicalName,
          member_role: m.memberRole,
          has_priority: m.hasPriority,
          joined_at: m.joinedAt.toISOString(),
        })),
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id/online',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const rows = await app.db
        .select({
          serverId: playerSessions.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          playerId: players.id,
          canonicalName: players.canonicalName,
          connectedAt: playerSessions.connectedAt,
        })
        .from(clanMembers)
        .innerJoin(
          playerSessions,
          and(
            eq(playerSessions.playerId, clanMembers.playerId),
            isNull(playerSessions.disconnectedAt),
          ),
        )
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .innerJoin(servers, eq(servers.id, playerSessions.serverId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(servers.displayName), asc(playerSessions.connectedAt));

      const byServer = new Map<
        string,
        {
          server_id: string;
          server_name: string;
          server_slug: string;
          members: Array<{
            player_id: string;
            name: string;
            team: string | null;
            squad: string | null;
            session_started_at: string;
          }>;
        }
      >();
      for (const row of rows) {
        let group = byServer.get(row.serverId);
        if (!group) {
          group = {
            server_id: row.serverId,
            server_name: row.serverName,
            server_slug: row.serverSlug,
            members: [],
          };
          byServer.set(row.serverId, group);
        }
        group.members.push({
          player_id: row.playerId,
          name: row.canonicalName,
          team: null,
          squad: null,
          session_started_at: row.connectedAt.toISOString(),
        });
      }

      return { clan_id: clan.id, servers: Array.from(byServer.values()) };
    },
  );

  fast.post(
    '/api/v1/clans',
    { schema: { body: createBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const id = uuidv7();
      try {
        await app.db.insert(clans).values({
          id,
          name: req.body.name,
          description: req.body.description ?? null,
          tags: req.body.tags ?? [],
          maxPrioritySlots: req.body.max_priority_slots ?? 10,
          primaryServerId: req.body.primary_server_id ?? null,
          isPublic: req.body.is_public ?? false,
          isTagProtected: req.body.is_tag_protected ?? false,
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
      const created = await loadActiveClan(id);
      if (!created) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.create',
        targetType: 'clan',
        targetId: id,
        before: null,
        after: clanSnapshot(created),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      reply.code(201);
      return toClanDto(created);
    },
  );

  fast.patch(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams, body: updateBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
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
      if (!req.user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, req.user.playerId);
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
      try {
        await app.db
          .update(clans)
          .set(updates)
          .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
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
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/settings',
    { schema: { params: clanIdParams, body: settingsBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, req.user.playerId);
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
      await app.db
        .update(clans)
        .set(updates)
        .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.settings.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/expire',
    { schema: { params: clanIdParams, body: expireBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const before = clanSnapshot(clan);
      const expiresAt = req.body.priority_expires_at
        ? new Date(req.body.priority_expires_at)
        : null;
      await app.db
        .update(clans)
        .set({ priorityExpiresAt: expiresAt, updatedAt: new Date() })
        .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.expire.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.delete(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const before = clanSnapshot(clan);
      const disbandedAt = new Date();
      await app.db.transaction(async (tx) => {
        await tx
          .update(clanMembers)
          .set({ hasPriority: false })
          .where(eq(clanMembers.clanId, clan.id));
        await tx
          .update(clans)
          .set({ deletedAt: disbandedAt, updatedAt: disbandedAt })
          .where(eq(clans.id, clan.id));
      });
      const afterRows = await app.db.select().from(clans).where(eq(clans.id, clan.id)).limit(1);
      const after = afterRows[0];
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.disband',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: after ? clanSnapshot(after) : null,
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return { ok: true };
    },
  );
};

export default clansRoutes;
