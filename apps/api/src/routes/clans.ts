import { clanMembers, clans, players } from '@squad/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const clanIdParams = z.object({ id: z.string().uuid() });

const clansRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

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
      const clanRows = await app.db
        .select()
        .from(clans)
        .where(and(eq(clans.id, req.params.id), isNull(clans.deletedAt)))
        .limit(1);
      const clan = clanRows[0];
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
        id: clan.id,
        name: clan.name,
        tags: clan.tags,
        description: clan.description,
        max_priority_slots: clan.maxPrioritySlots,
        priority_expires_at: clan.priorityExpiresAt ? clan.priorityExpiresAt.toISOString() : null,
        is_tag_protected: clan.isTagProtected,
        is_public: clan.isPublic,
        primary_server_id: clan.primaryServerId,
        created_at: clan.createdAt.toISOString(),
        updated_at: clan.updatedAt.toISOString(),
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
};

export default clansRoutes;
