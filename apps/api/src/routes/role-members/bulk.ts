import { players, roles } from '@squad/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { publishDiscordRoleSync } from '../../lib/discord-role-sync.js';
import { invalidatePermissionCache } from '../../lib/rbac.js';
import { roleCeilingError, roleGrantBeyondActor } from '../../lib/role-guards.js';
import { checkRoleAssignment } from '../../lib/role-hierarchy.js';
import { roleIdParam } from '../../lib/role-members/common.js';
import { revokeAllForPlayers } from '../../lib/sessions.js';

const BULK_MAX_IDS = 5000;

const bulkDeleteBody = z.object({
  player_ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_IDS),
});
const moveBody = z.object({
  player_ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_IDS),
  target_role_id: z.string().uuid(),
});

/** Bulk removal and move of role members. */
const roleMemberBulkRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * The subset of `playerIds` that currently hold `roleId` — the players a
   * bulk remove/move scoped to `roleId = :id` would actually change.
   */
  async function membersOf(roleId: string, playerIds: readonly string[]): Promise<string[]> {
    const rows = await app.db
      .select({ id: players.id })
      .from(players)
      .where(and(eq(players.roleId, roleId), inArray(players.id, [...playerIds])));
    return rows.map((row) => row.id);
  }

  // Bulk-remove selected members from this role (scoped to `roleId = :id`).
  fast.post(
    '/api/v1/roles/:id/members/bulk-delete',
    {
      schema: { params: roleIdParam, body: bulkDeleteBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.bulk_remove', resource: 'role' },
      },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const r = role[0]!;
      const playerIds = [...new Set(req.body.player_ids)];
      const hierarchyRefusal = await checkRoleAssignment(app.db, req.user, {
        playerIds: await membersOf(r.id, playerIds),
        newRoleId: null,
      });
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }

      if (r.isSystemRole && r.name === 'Owner') {
        const totalRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, r.id));
        const affectedRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(and(eq(players.roleId, r.id), inArray(players.id, playerIds)));
        const remaining = (totalRows[0]?.c ?? 0) - (affectedRows[0]?.c ?? 0);
        if (remaining < 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }

      let removedIds: string[] = [];
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: null, roleExpiresAt: null, roleComment: null })
          .where(and(eq(players.roleId, r.id), inArray(players.id, playerIds)))
          .returning({ id: players.id });
        removedIds = updated.map((u) => u.id);
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'role.member.bulk_remove',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const id of removedIds) invalidatePermissionCache(id);
      if (removedIds.length > 0) {
        await publishDiscordRoleSync(app.redis, null, 'role.member.bulk_remove', app.log);
      }
      await revokeAllForPlayers(app.db, app.redis, removedIds, app.liveBus);
      return { ok: true, removed: removedIds.length };
    },
  );

  // Move selected members from this role to a target role.
  fast.post(
    '/api/v1/roles/:id/members/move',
    {
      schema: { params: roleIdParam, body: moveBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.move', resource: 'role' },
      },
    },
    async (req, reply) => {
      const source = await app.db
        .select({ id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (source.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const src = source[0]!;

      if (req.body.target_role_id === req.params.id) {
        reply.code(400);
        return { error: 'target_role_same_as_source' };
      }
      const targetRows = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, req.body.target_role_id))
        .limit(1);
      if (targetRows.length === 0) {
        reply.code(404);
        return { error: 'target_role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const targetRole = targetRows[0]!;
      if (targetRole.isSystemRole && targetRole.name === 'Owner') {
        reply.code(403);
        return { error: 'owner_assignment_forbidden' };
      }
      const beyond = await roleGrantBeyondActor(app.db, targetRole.id, req.user?.permissions);
      if (beyond.length > 0) {
        reply.code(403);
        return roleCeilingError(beyond);
      }

      const playerIds = [...new Set(req.body.player_ids)];
      const hierarchyRefusal = await checkRoleAssignment(app.db, req.user, {
        playerIds: await membersOf(src.id, playerIds),
        newRoleId: targetRole.id,
      });
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
      if (src.isSystemRole && src.name === 'Owner') {
        const totalRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, src.id));
        const affectedRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(and(eq(players.roleId, src.id), inArray(players.id, playerIds)));
        const remaining = (totalRows[0]?.c ?? 0) - (affectedRows[0]?.c ?? 0);
        if (remaining < 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }

      let movedIds: string[] = [];
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: targetRole.id, roleExpiresAt: null, roleComment: null })
          .where(and(eq(players.roleId, src.id), inArray(players.id, playerIds)))
          .returning({ id: players.id });
        movedIds = updated.map((u) => u.id);
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'role.member.move',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const id of movedIds) invalidatePermissionCache(id);
      if (movedIds.length > 0) {
        await publishDiscordRoleSync(app.redis, null, 'role.member.move', app.log);
      }
      if (!targetRole.panelAccess) {
        await revokeAllForPlayers(app.db, app.redis, movedIds, app.liveBus);
      }
      return { ok: true, moved: movedIds.length };
    },
  );
};

export default roleMemberBulkRoutes;
