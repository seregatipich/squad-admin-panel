import { players, roles } from '@squad/db/schema';
import { isAdminsCfgSingleLineText } from '@squad/shared-config';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { publishDiscordRoleSync } from '../../lib/discord-role-sync.js';
import { steamId64Equals } from '../../lib/player-search.js';
import { invalidatePermissionCache } from '../../lib/rbac.js';
import { checkRoleAssignment } from '../../lib/role-hierarchy.js';
import { COMMENT_MAX_LEN, roleIdParam } from '../../lib/role-members/common.js';
import { revokeAllForPlayer } from '../../lib/sessions.js';
import { escapeLike } from '../../lib/sql-like.js';

const listQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const memberBody = z.object({
  player_id: z.string().uuid(),
  // Written into Admins.cfg after `//`, so it must stay on one line (#11).
  comment: z
    .string()
    .trim()
    .max(COMMENT_MAX_LEN)
    .refine(isAdminsCfgSingleLineText, { message: 'comment_not_single_line' })
    .nullable()
    .optional(),
});
const memberParam = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
});

/** Role member list, add and remove. */
const roleMemberListRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/roles/:id/members',
    {
      schema: { params: roleIdParam, querystring: listQuery },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name, color: roles.color })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      const q = req.query.q?.toLowerCase().trim();
      // `%`/`_` in the query match literally; a full SteamID64 is compared as
      // a bigint so the steam_id64 index serves it.
      const nameMatch = q
        ? ilike(players.canonicalNameNormalized, `%${escapeLike(q)}%`)
        : undefined;
      const where = q
        ? and(
            eq(players.roleId, req.params.id),
            or(nameMatch, steamId64Equals(players.steamId64, q)),
          )
        : eq(players.roleId, req.params.id);
      const totalRows = await app.db
        .select({ c: sql<number>`count(*)::int` })
        .from(players)
        .where(where);
      const total = totalRows[0]?.c ?? 0;
      const items = await app.db
        .select({
          id: players.id,
          steamId64: players.steamId64,
          canonicalName: players.canonicalName,
          lastSeenAt: players.lastSeenAt,
          roleComment: players.roleComment,
        })
        .from(players)
        .where(where)
        .orderBy(asc(players.canonicalNameNormalized))
        .limit(req.query.limit)
        .offset(req.query.offset);
      return {
        // biome-ignore lint/style/noNonNullAssertion: length-check above
        role: role[0]!,
        items: items.map((r) => ({
          id: r.id,
          steam_id64: r.steamId64 ? r.steamId64.toString() : null,
          canonical_name: r.canonicalName,
          last_seen_at: r.lastSeenAt,
          role_comment: r.roleComment,
        })),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );

  fast.post(
    '/api/v1/roles/:id/members',
    {
      schema: { params: roleIdParam, body: memberBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.add', resource: 'role' },
      },
    },
    async (req, reply) => {
      const target = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const role = target[0]!;
      if (role.isSystemRole && role.name === 'Owner') {
        reply.code(403);
        return { error: 'owner_assignment_forbidden' };
      }
      const playerId = req.body.player_id;
      const rawComment = req.body.comment?.trim() ?? null;
      const comment = rawComment === '' ? null : rawComment;
      const player = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (player.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      const hierarchyRefusal = await checkRoleAssignment(app.db, req.user, {
        playerIds: [playerId],
        newRoleId: role.id,
      });
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
      await app.db.transaction(async (tx) => {
        await tx
          .update(players)
          .set({ roleId: req.params.id, roleExpiresAt: null, roleComment: comment })
          .where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'role.member.add',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);
      await publishDiscordRoleSync(app.redis, playerId, 'role.member.add', app.log);
      if (!role.panelAccess) {
        await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      }
      reply.code(201);
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/roles/:id/members/:playerId',
    {
      schema: { params: memberParam },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.remove', resource: 'role' },
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
      const playerId = req.params.playerId;
      const hierarchyRefusal = await checkRoleAssignment(app.db, req.user, {
        playerIds: [playerId],
        newRoleId: null,
      });
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
      if (r.isSystemRole && r.name === 'Owner') {
        const membership = await app.db
          .select({ id: players.id })
          .from(players)
          .where(and(eq(players.id, playerId), eq(players.roleId, r.id)))
          .limit(1);
        if (membership.length === 0) return { ok: true };
        const count = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, r.id));
        if ((count[0]?.c ?? 0) <= 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }
      const removed = await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: null, roleComment: null, roleExpiresAt: null })
          .where(and(eq(players.id, playerId), eq(players.roleId, r.id)))
          .returning({ id: players.id });
        if (updated.length === 0) return false;
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'role.member.remove',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
        return true;
      });
      if (!removed) return { ok: true };
      invalidatePermissionCache(playerId);
      await publishDiscordRoleSync(app.redis, playerId, 'role.member.remove', app.log);
      await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      return { ok: true };
    },
  );
};

export default roleMemberListRoutes;
