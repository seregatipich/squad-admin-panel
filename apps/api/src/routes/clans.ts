import type { ClanRow } from '@squad/db/schema';
import {
  clanMembers,
  clans,
  matches,
  matchPlayers,
  playerSessions,
  players,
  servers,
} from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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

const MATCHES_LIMIT_DEFAULT = 20;
const MATCHES_LIMIT_MAX = 100;

const matchesQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MATCHES_LIMIT_MAX).default(MATCHES_LIMIT_DEFAULT),
  server_id: z.string().uuid().optional(),
});

interface MatchesCursor {
  v: number;
  id: string;
}

function encodeMatchesCursor(cursor: MatchesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function parseMatchesCursor(raw: string): MatchesCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as MatchesCursor;
    if (!decoded || typeof decoded !== 'object') return null;
    if (typeof decoded.v !== 'number' || !Number.isFinite(decoded.v)) return null;
    if (typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)) return null;
    return decoded;
  } catch {
    return null;
  }
}

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

const assignableMemberRole = z.enum(['deputy', 'member']);

const rosterQuery = z.object({
  q: z.string().trim().min(1).max(64).optional(),
  sort: z
    .enum(['name', 'role', 'priority', 'joined_at', 'last_seen', 'online'])
    .default('joined_at'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const addMemberBody = z.object({
  player_id: z.string().uuid(),
  member_role: assignableMemberRole.default('member'),
});

const setMemberRoleBody = z.object({ member_role: assignableMemberRole });

const transferBody = z.object({ player_id: z.string().uuid() });

const memberParams = z.object({ id: z.string().uuid(), playerId: z.string().uuid() });

interface RosterRow {
  player_id: string;
  member_role: string;
  has_priority: boolean;
  joined_at: string;
  canonical_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  last_seen_at: string | null;
  online_60d: number;
}

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

  async function clanManageLevel(
    clanId: string,
    user: NonNullable<FastifyRequest['user']>,
  ): Promise<'full' | 'deputy' | null> {
    if (user.permissions.canManageClans) return 'full';
    const role = await membershipRole(clanId, user.playerId);
    if (role === 'leader') return 'full';
    if (role === 'deputy') return 'deputy';
    return null;
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

  fast.get(
    '/api/v1/clans/:id/matches',
    { schema: { params: clanIdParams, querystring: matchesQuery }, config: { audit: false } },
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

      const { limit, server_id: serverId } = req.query;
      const participationExists = sql`EXISTS (
        SELECT 1 FROM ${matchPlayers} mp
        JOIN ${clanMembers} cm ON cm.player_id = mp.player_id
        WHERE mp.match_id = ${matches.id} AND cm.clan_id = ${clan.id}
      )`;

      const clauses = [participationExists];
      if (serverId) clauses.push(eq(matches.serverId, serverId));

      if (req.query.cursor) {
        const cursor = parseMatchesCursor(req.query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const startedAt = new Date(cursor.v);
        const keyset = or(
          lt(matches.startedAt, startedAt),
          and(eq(matches.startedAt, startedAt), lt(matches.id, cursor.id)),
        );
        if (keyset) clauses.push(keyset);
      }

      const rows = await app.db
        .select({
          id: matches.id,
          serverId: matches.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          layer: matches.layer,
          map: matches.map,
          team1Faction: matches.team1Faction,
          team2Faction: matches.team2Faction,
          team1Tickets: matches.team1Tickets,
          team2Tickets: matches.team2Tickets,
          winner: matches.winner,
          isSeed: matches.isSeed,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          durationSeconds: matches.durationSeconds,
        })
        .from(matches)
        .leftJoin(servers, eq(servers.id, matches.serverId))
        .where(and(...clauses))
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last ? encodeMatchesCursor({ v: last.startedAt.getTime(), id: last.id }) : null;

      const participantsByMatch = new Map<
        string,
        Array<{ player_id: string; name: string; member_role: string }>
      >();
      if (page.length > 0) {
        const participantRows = await app.db
          .select({
            matchId: matchPlayers.matchId,
            playerId: players.id,
            canonicalName: players.canonicalName,
            memberRole: clanMembers.memberRole,
          })
          .from(matchPlayers)
          .innerJoin(
            clanMembers,
            and(eq(clanMembers.playerId, matchPlayers.playerId), eq(clanMembers.clanId, clan.id)),
          )
          .innerJoin(players, eq(players.id, matchPlayers.playerId))
          .where(
            inArray(
              matchPlayers.matchId,
              page.map((row) => row.id),
            ),
          )
          .orderBy(asc(players.canonicalName));
        for (const participant of participantRows) {
          let group = participantsByMatch.get(participant.matchId);
          if (!group) {
            group = [];
            participantsByMatch.set(participant.matchId, group);
          }
          group.push({
            player_id: participant.playerId,
            name: participant.canonicalName,
            member_role: participant.memberRole,
          });
        }
      }

      return {
        clan_id: clan.id,
        items: page.map((row) => {
          const participants = participantsByMatch.get(row.id) ?? [];
          return {
            id: row.id,
            server_id: row.serverId,
            server_name: row.serverName,
            server_slug: row.serverSlug,
            layer: row.layer,
            map: row.map,
            team1_faction: row.team1Faction,
            team2_faction: row.team2Faction,
            team1_tickets: row.team1Tickets,
            team2_tickets: row.team2Tickets,
            winner: row.winner,
            is_seed: row.isSeed,
            started_at: row.startedAt.toISOString(),
            ended_at: row.endedAt ? row.endedAt.toISOString() : null,
            duration_seconds: row.durationSeconds,
            clan_participants_count: participants.length,
            participants,
          };
        }),
        next_cursor: nextCursor,
        limit,
      };
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

  fast.get(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, querystring: rosterQuery }, config: { audit: false } },
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
      const { q, sort, order, page, limit } = req.query;
      const offset = (page - 1) * limit;

      const filters = [sql`cm.clan_id = ${clan.id}`];
      if (q) {
        const nameMatch = normalizePlayerName(q);
        const exactMatch = q.toLowerCase();
        filters.push(
          sql`(p.canonical_name_normalized LIKE ${`%${nameMatch}%`} OR p.steam_id64::text = ${exactMatch} OR p.eos_id = ${exactMatch})`,
        );
      }
      const whereSql = and(...filters);

      const sortColumn = {
        name: sql`p.canonical_name`,
        role: sql`cm.member_role`,
        priority: sql`cm.has_priority`,
        joined_at: sql`cm.joined_at`,
        last_seen: sql`p.last_seen_at`,
        online: sql`online_60d`,
      }[sort];
      const direction = order === 'asc' ? sql`ASC` : sql`DESC`;

      const rows = (await app.db.execute(sql`
        SELECT cm.player_id, cm.member_role, cm.has_priority,
               cm.joined_at::text AS joined_at,
               p.canonical_name, p.steam_id64::text AS steam_id64, p.eos_id,
               p.last_seen_at::text AS last_seen_at,
               COALESCE(pres.online, 0)::int AS online_60d
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        LEFT JOIN (
          SELECT player_id, SUM(online_seconds) AS online
          FROM player_daily_presence
          WHERE day >= (CURRENT_DATE - INTERVAL '60 days')
          GROUP BY player_id
        ) pres ON pres.player_id = cm.player_id
        WHERE ${whereSql}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, cm.joined_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as RosterRow[];

      const countRows = (await app.db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        WHERE ${whereSql}
      `)) as unknown as Array<{ total: number }>;
      const total = countRows[0]?.total ?? 0;

      return {
        clan_id: clan.id,
        items: rows.map((row) => ({
          player_id: row.player_id,
          canonical_name: row.canonical_name,
          steam_id64: row.steam_id64,
          eos_id: row.eos_id,
          member_role: row.member_role,
          has_priority: row.has_priority,
          joined_at: new Date(row.joined_at).toISOString(),
          last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
          online_60d_seconds: Number(row.online_60d),
        })),
        total,
        page,
        limit,
      };
    },
  );

  fast.post(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, body: addMemberBody }, config: { audit: false } },
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
      const level = await clanManageLevel(clan.id, req.user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      if (level === 'deputy' && req.body.member_role !== 'member') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const [player] = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, req.body.player_id))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      try {
        await app.db.insert(clanMembers).values({
          clanId: clan.id,
          playerId: req.body.player_id,
          memberRole: req.body.member_role,
          hasPriority: false,
        });
      } catch (err) {
        const { code } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return { error: 'player_already_in_clan' };
        }
        throw err;
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.add',
        targetType: 'clan',
        targetId: clan.id,
        before: null,
        after: { player_id: req.body.player_id, member_role: req.body.member_role },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      reply.code(201);
      return {
        clan_id: clan.id,
        player_id: req.body.player_id,
        member_role: req.body.member_role,
      };
    },
  );

  fast.patch(
    '/api/v1/clans/:id/members/:playerId',
    { schema: { params: memberParams, body: setMemberRoleBody }, config: { audit: false } },
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
      const level = await clanManageLevel(clan.id, req.user);
      if (level !== 'full') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const currentRole = await membershipRole(clan.id, req.params.playerId);
      if (!currentRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (currentRole === 'leader') {
        reply.code(409);
        return { error: 'cannot_demote_leader' };
      }
      if (currentRole !== req.body.member_role) {
        await app.db
          .update(clanMembers)
          .set({ memberRole: req.body.member_role })
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
          );
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.role',
        targetType: 'clan',
        targetId: clan.id,
        before: { player_id: req.params.playerId, member_role: currentRole },
        after: { player_id: req.params.playerId, member_role: req.body.member_role },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return {
        clan_id: clan.id,
        player_id: req.params.playerId,
        member_role: req.body.member_role,
      };
    },
  );

  fast.delete(
    '/api/v1/clans/:id/members/:playerId',
    { schema: { params: memberParams }, config: { audit: false } },
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
      const level = await clanManageLevel(clan.id, req.user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const currentRole = await membershipRole(clan.id, req.params.playerId);
      if (!currentRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (level === 'deputy' && currentRole !== 'member') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      if (currentRole === 'leader') {
        reply.code(409);
        return { error: 'sole_leader_removal' };
      }
      await app.db
        .delete(clanMembers)
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)));
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.remove',
        targetType: 'clan',
        targetId: clan.id,
        before: { player_id: req.params.playerId, member_role: currentRole },
        after: null,
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/clans/:id/transfer-leadership',
    { schema: { params: clanIdParams, body: transferBody }, config: { audit: false } },
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
      const level = await clanManageLevel(clan.id, req.user);
      if (level !== 'full') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const newLeaderRole = await membershipRole(clan.id, req.body.player_id);
      if (!newLeaderRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (newLeaderRole === 'leader') {
        reply.code(409);
        return { error: 'already_leader' };
      }
      const [currentLeader] = await app.db
        .select({ playerId: clanMembers.playerId })
        .from(clanMembers)
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.memberRole, 'leader')))
        .limit(1);
      const previousLeaderId = currentLeader?.playerId ?? null;
      await app.db.transaction(async (tx) => {
        if (previousLeaderId) {
          await tx
            .update(clanMembers)
            .set({ memberRole: 'deputy' })
            .where(
              and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, previousLeaderId)),
            );
        }
        await tx
          .update(clanMembers)
          .set({ memberRole: 'leader' })
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.body.player_id)),
          );
      });
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.leadership.transfer',
        targetType: 'clan',
        targetId: clan.id,
        before: { leader_id: previousLeaderId },
        after: { leader_id: req.body.player_id },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return {
        ok: true,
        clan_id: clan.id,
        leader_id: req.body.player_id,
        previous_leader_id: previousLeaderId,
      };
    },
  );
};

export default clansRoutes;
