import { clanMembers, clans, players, roleSquadPermissions } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { writeAuditEntry } from '../../lib/audit.js';
import { clanAccess } from '../../lib/clans/access.js';
import {
  auditActor,
  memberParams,
  pgError,
  RESERVE_SQUAD_PERMISSION_KEY,
} from '../../lib/clans/common.js';
import { requestUser } from '../../lib/request-user.js';

const setPriorityBody = z.object({ enabled: z.boolean() });

/** Thrown inside the priority-toggle transaction to abort with a rollback when the pool is full. */
class PriorityPoolLimitError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super('priority_pool_limit');
  }
}

/** Per-member reserve-slot (priority) toggle. */
const clanPriorityRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan, clanManageLevel } = clanAccess(app);

  fast.put(
    '/api/v1/clans/:id/members/:playerId/priority',
    { schema: { params: memberParams, body: setPriorityBody }, config: { audit: 'manual' } },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const [member] = await app.db
        .select({
          hasPriority: clanMembers.hasPriority,
          memberRole: clanMembers.memberRole,
          roleId: players.roleId,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)))
        .limit(1);
      if (!member) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      // Like adding and removing members, a deputy acts on rank-and-file
      // members only — never on the leader, another deputy or itself (#125).
      if (level === 'deputy' && member.memberRole !== 'member') {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const enabled = req.body.enabled;
      if (enabled === member.hasPriority) {
        const countRows = await app.db
          .select({ count: sql<number>`count(*)::int` })
          .from(clanMembers)
          .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
        return {
          player_id: req.params.playerId,
          has_priority: member.hasPriority,
          priority_count: Number(countRows[0]?.count ?? 0),
          max_priority_slots: clan.maxPrioritySlots,
        };
      }

      if (enabled) {
        const now = new Date();
        if (clan.priorityExpiresAt && clan.priorityExpiresAt <= now) {
          reply.code(409);
          return { error: 'priority_expired' };
        }
        if (member.roleId) {
          const [conflict] = await app.db
            .select({ roleId: roleSquadPermissions.roleId })
            .from(roleSquadPermissions)
            .where(
              and(
                eq(roleSquadPermissions.roleId, member.roleId),
                eq(roleSquadPermissions.squadPermissionKey, RESERVE_SQUAD_PERMISSION_KEY),
              ),
            )
            .limit(1);
          if (conflict) {
            reply.code(409);
            return { error: 'priority_source_conflict' };
          }
        }
      }

      let priorityCount = 0;
      try {
        await app.db.transaction(async (tx) => {
          if (enabled) {
            // Serialize concurrent toggles against the same clan so the
            // pool-limit check below can't race past max_priority_slots, and
            // re-read the limit under that lock: a concurrent PATCH may have
            // lowered it since the clan was loaded (#130).
            const [locked] = await tx
              .select({ maxPrioritySlots: clans.maxPrioritySlots })
              .from(clans)
              .where(eq(clans.id, clan.id))
              .for('update');
            const limit = locked?.maxPrioritySlots ?? clan.maxPrioritySlots;
            const countRows = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(clanMembers)
              .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
            const used = Number(countRows[0]?.count ?? 0);
            if (used + 1 > limit) {
              throw new PriorityPoolLimitError(used, limit);
            }
            priorityCount = used + 1;
          } else {
            const countRows = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(clanMembers)
              .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
            priorityCount = Math.max(0, Number(countRows[0]?.count ?? 0) - 1);
          }
          await tx
            .update(clanMembers)
            .set({ hasPriority: enabled })
            .where(
              and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
            );
          await publishAdminsCfgSyncForAllServers(tx, {
            reason: 'clan.priority.toggle',
            actor_player_id: user.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
          await writeAuditEntry(tx, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'clan.member.priority',
            targetType: 'clan',
            targetId: clan.id,
            before: { player_id: req.params.playerId, has_priority: member.hasPriority },
            after: { player_id: req.params.playerId, has_priority: enabled },
            context: { requestId: req.id, method: req.method, url: req.url },
          });
        });
      } catch (err) {
        if (err instanceof PriorityPoolLimitError) {
          reply.code(409);
          return { error: 'priority_pool_limit', limit: err.limit, used: err.used };
        }
        // The deferred clan_members_priority_limit trigger is the last line
        // of defence against a limit change that slipped past the lock.
        if (pgError(err).code === '23514') {
          reply.code(409);
          return { error: 'priority_pool_limit' };
        }
        throw err;
      }

      return {
        player_id: req.params.playerId,
        has_priority: enabled,
        priority_count: priorityCount,
        max_priority_slots: clan.maxPrioritySlots,
      };
    },
  );
};

export default clanPriorityRoutes;
