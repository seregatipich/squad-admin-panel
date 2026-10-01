import { clanMembers, clans, players } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { writeAuditEntry } from '../../lib/audit.js';
import { clanAccess } from '../../lib/clans/access.js';
import { auditActor, clanIdParams, memberParams, pgError } from '../../lib/clans/common.js';
import { requestUser } from '../../lib/request-user.js';

const assignableMemberRole = z.enum(['deputy', 'member']);

const addMemberBody = z.object({
  player_id: z.string().uuid(),
  member_role: assignableMemberRole.default('member'),
});

const setMemberRoleBody = z.object({ member_role: assignableMemberRole });

const transferBody = z.object({ player_id: z.string().uuid() });

/** Adding, re-roling and removing clan members, and leadership transfer. */
const clanMembersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan, membershipRole, clanManageLevel } = clanAccess(app);

  fast.post(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, body: addMemberBody }, config: { audit: 'manual' } },
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
      // A non-empty clan must have exactly one leader (the deferred
      // clan_members_single_leader trigger), and a clan created through the
      // API starts empty, so its first member becomes the leader regardless of
      // the requested role. The row lock serializes concurrent first adds so
      // only one of them sees the clan empty, and orders the add against a
      // concurrent disband so no row is left behind a deleted clan.
      let memberRole: 'leader' | 'deputy' | 'member' = req.body.member_role;
      let clanStillActive = true;
      try {
        await app.db.transaction(async (tx) => {
          const locked = await tx.execute(
            sql`SELECT id FROM clans WHERE id = ${clan.id} AND deleted_at IS NULL FOR UPDATE`,
          );
          if (locked.length === 0) {
            clanStillActive = false;
            return;
          }
          const [existing] = await tx
            .select({ playerId: clanMembers.playerId })
            .from(clanMembers)
            .where(eq(clanMembers.clanId, clan.id))
            .limit(1);
          if (!existing) memberRole = 'leader';
          await tx.insert(clanMembers).values({
            clanId: clan.id,
            playerId: req.body.player_id,
            memberRole,
            hasPriority: false,
          });
          await writeAuditEntry(tx, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'clan.member.add',
            targetType: 'clan',
            targetId: clan.id,
            before: null,
            after: { player_id: req.body.player_id, member_role: memberRole },
            context: { requestId: req.id, method: req.method, url: req.url },
          });
        });
      } catch (err) {
        const { code } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return { error: 'player_already_in_clan' };
        }
        // The deferred clan_members_single_leader trigger (check_violation) can
        // fire when a full-permission caller explicitly requests
        // member_role:'leader' for a clan that already has one — surface it as
        // a 409 instead of an unhandled 500.
        if (code === '23514') {
          reply.code(409);
          return { error: 'leader_conflict' };
        }
        throw err;
      }
      if (!clanStillActive) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      reply.code(201);
      const roleOverridden = memberRole !== req.body.member_role;
      return {
        clan_id: clan.id,
        player_id: req.body.player_id,
        member_role: memberRole,
        // The API's own contract for #14's silent override: the UI can show a
        // hint whenever the requested role was not honored (first member of
        // an empty clan is always forced to 'leader').
        role_overridden: roleOverridden,
      };
    },
  );

  fast.patch(
    '/api/v1/clans/:id/members/:playerId',
    { schema: { params: memberParams, body: setMemberRoleBody }, config: { audit: 'manual' } },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, user);
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
      await app.db.transaction(async (tx) => {
        if (currentRole !== req.body.member_role) {
          await tx
            .update(clanMembers)
            .set({ memberRole: req.body.member_role })
            .where(
              and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
            );
        }
        await writeAuditEntry(tx, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'clan.member.role',
          targetType: 'clan',
          targetId: clan.id,
          before: { player_id: req.params.playerId, member_role: currentRole },
          after: { player_id: req.params.playerId, member_role: req.body.member_role },
          context: { requestId: req.id, method: req.method, url: req.url },
        });
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
    { schema: { params: memberParams }, config: { audit: 'manual' } },
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
      await app.db.transaction(async (tx) => {
        // The deleted row itself says whether a reserve slot was released
        // (#129): reading has_priority beforehand raced a concurrent toggle.
        const [removed] = await tx
          .delete(clanMembers)
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
          )
          .returning({ hasPriority: clanMembers.hasPriority });
        if (removed?.hasPriority) {
          await publishAdminsCfgSyncForAllServers(tx, {
            reason: 'clan.member.remove',
            actor_player_id: user.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
        }
        await writeAuditEntry(tx, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'clan.member.remove',
          targetType: 'clan',
          targetId: clan.id,
          before: { player_id: req.params.playerId, member_role: currentRole },
          after: null,
          context: { requestId: req.id, method: req.method, url: req.url },
        });
      });
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/clans/:id/transfer-leadership',
    { schema: { params: clanIdParams, body: transferBody }, config: { audit: 'manual' } },
    async (req, reply) => {
      const user = requestUser(req);
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, user);
      if (level !== 'full') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      // The clan row lock serialises concurrent transfers (#130): each one
      // re-reads the roster under it, so the second demotes whoever the first
      // promoted instead of both racing into the single-leader trigger.
      let outcome:
        | { ok: true; previousLeaderId: string | null }
        | { ok: false; code: 404 | 409; error: string };
      try {
        outcome = await app.db.transaction(async (tx) => {
          await tx.select({ id: clans.id }).from(clans).where(eq(clans.id, clan.id)).for('update');
          const roster = await tx
            .select({ playerId: clanMembers.playerId, role: clanMembers.memberRole })
            .from(clanMembers)
            .where(eq(clanMembers.clanId, clan.id));
          const candidate = roster.find((row) => row.playerId === req.body.player_id);
          if (!candidate) return { ok: false, code: 404, error: 'member_not_found' } as const;
          if (candidate.role === 'leader') {
            return { ok: false, code: 409, error: 'already_leader' } as const;
          }
          const previousLeaderId = roster.find((row) => row.role === 'leader')?.playerId ?? null;
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
          await writeAuditEntry(tx, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'clan.leadership.transfer',
            targetType: 'clan',
            targetId: clan.id,
            before: { leader_id: previousLeaderId },
            after: { leader_id: req.body.player_id },
            context: { requestId: req.id, method: req.method, url: req.url },
          });
          return { ok: true, previousLeaderId } as const;
        });
      } catch (err) {
        if (pgError(err).code === '23514') {
          reply.code(409);
          return { error: 'leadership_conflict' };
        }
        throw err;
      }
      if (!outcome.ok) {
        reply.code(outcome.code);
        return { error: outcome.error };
      }
      return {
        ok: true,
        clan_id: clan.id,
        leader_id: req.body.player_id,
        previous_leader_id: outcome.previousLeaderId,
      };
    },
  );
};

export default clanMembersRoutes;
