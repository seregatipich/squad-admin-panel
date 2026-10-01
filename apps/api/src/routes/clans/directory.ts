import { clanMembers, clans, playerSessions, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clanAccess } from '../../lib/clans/access.js';
import { clanIdParams, RESERVE_SQUAD_PERMISSION_KEY, toClanDto } from '../../lib/clans/common.js';
import { requestUser } from '../../lib/request-user.js';
import { escapeLike } from '../../lib/sql-like.js';

/**
 * Query of `GET /api/v1/clans/:id`. `include=members` (the default, so existing
 * clients are unaffected) returns the full roster; `include=none` returns only
 * the clan header plus `priority_count`, skipping the roster JOIN.
 */
const clanDetailQuery = z.object({ include: z.enum(['members', 'none']).default('members') });

/**
 * Query of `GET /api/v1/clans`. Every field is optional and omitting them all
 * returns the whole directory (the pre-pagination contract): `q` matches the
 * name or any tag case-insensitively, `sort`/`order` default to name ascending,
 * and `limit` (with 1-based `page`) switches on pagination.
 */
const clanListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['name', 'members', 'priority']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Clan directory, detail and live-online reads. */
const clanDirectoryRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan } = clanAccess(app);

  fast.get(
    '/api/v1/clans',
    { schema: { querystring: clanListQuery }, config: { audit: false } },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const { q, sort, order, page, limit } = req.query;
      const needle = q ? `%${escapeLike(q.toLowerCase())}%` : null;
      const where = and(
        isNull(clans.deletedAt),
        needle
          ? sql`(lower(${clans.name}) LIKE ${needle} OR EXISTS (
              SELECT 1 FROM unnest(${clans.tags}) AS tag WHERE lower(tag) LIKE ${needle}
            ))`
          : undefined,
      );
      const memberCount = sql<number>`count(${clanMembers.playerId})::int`;
      const priorityCount = sql<number>`(count(*) FILTER (WHERE ${clanMembers.hasPriority}))::int`;
      const direction = order === 'asc' ? asc : desc;
      const sortColumn =
        sort === 'members' ? memberCount : sort === 'priority' ? priorityCount : clans.name;
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
          memberCount,
          priorityCount,
        })
        .from(clans)
        .leftJoin(clanMembers, eq(clanMembers.clanId, clans.id))
        .where(where)
        .groupBy(clans.id)
        .orderBy(direction(sortColumn), asc(clans.name), asc(clans.id))
        .limit(limit ?? Number.MAX_SAFE_INTEGER)
        .offset(limit ? (page - 1) * limit : 0);
      const [totalRow] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(clans)
        .where(where);
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
        total: Number(totalRow?.total ?? 0),
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id',
    {
      schema: { params: clanIdParams, querystring: clanDetailQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (req.query.include === 'none') {
        const [counts] = await app.db
          .select({ priorityCount: sql<number>`count(*)::int` })
          .from(clanMembers)
          .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
        return { ...toClanDto(clan), priority_count: Number(counts?.priorityCount ?? 0) };
      }
      const members = await app.db
        .select({
          playerId: clanMembers.playerId,
          memberRole: clanMembers.memberRole,
          hasPriority: clanMembers.hasPriority,
          joinedAt: clanMembers.joinedAt,
          canonicalName: players.canonicalName,
          reserveFromRole: sql<boolean>`EXISTS (
            SELECT 1 FROM role_squad_permissions rsp
            WHERE rsp.role_id = ${players.roleId} AND rsp.squad_permission_key = ${RESERVE_SQUAD_PERMISSION_KEY}
          )`,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt));
      const priorityCount = members.filter((m) => m.hasPriority).length;
      return {
        ...toClanDto(clan),
        priority_count: priorityCount,
        members: members.map((m) => ({
          player_id: m.playerId,
          canonical_name: m.canonicalName,
          member_role: m.memberRole,
          has_priority: m.hasPriority,
          reserve_from_role: m.reserveFromRole,
          joined_at: m.joinedAt.toISOString(),
        })),
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id/online',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
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
};

export default clanDirectoryRoutes;
