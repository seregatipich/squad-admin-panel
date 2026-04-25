import {
  playerIpHistory,
  playerNameHistory,
  playerRoleAssignments,
  players,
  roles,
} from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const playerIdParams = z.object({ steamId: z.string().regex(/^\d{17}$/) });
const roleAssignBody = z.object({ role_id: z.string().uuid() });
const playerRoleParams = z.object({
  steamId: z.string().regex(/^\d{17}$/),
  roleId: z.string().uuid(),
});

const playerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players',
    {
      config: { permissions: ['player:view'], audit: false },
    },
    async () => {
      const rows = await app.db.select().from(players).orderBy(desc(players.lastSeenAt)).limit(200);
      return {
        items: rows.map((r) => ({
          steam_id64: r.steamId64.toString(),
          canonical_name: r.canonicalName,
          eos_id: r.eosId,
          first_seen_at: r.firstSeenAt,
          last_seen_at: r.lastSeenAt,
          total_time_played_seconds: Number(r.totalTimePlayedSeconds),
        })),
        total: rows.length,
      };
    },
  );

  fast.get(
    '/api/v1/players/:steamId',
    {
      config: { permissions: ['player:view'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req, reply) => {
      const id = BigInt(req.params.steamId);
      const row = await app.db.query.players.findFirst({
        where: eq(players.steamId64, id),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const names = await app.db
        .select()
        .from(playerNameHistory)
        .where(eq(playerNameHistory.steamId64, id))
        .orderBy(desc(playerNameHistory.lastSeenAt));
      const ipsVisible = req.user?.permissions.permissions.has('player:view_ips') ?? false;
      const ips = ipsVisible
        ? await app.db
            .select()
            .from(playerIpHistory)
            .where(eq(playerIpHistory.steamId64, id))
            .orderBy(desc(playerIpHistory.lastSeenAt))
        : [];
      return {
        player: {
          steam_id64: row.steamId64.toString(),
          canonical_name: row.canonicalName,
          eos_id: row.eosId,
          first_seen_at: row.firstSeenAt,
          last_seen_at: row.lastSeenAt,
          total_time_played_seconds: Number(row.totalTimePlayedSeconds),
        },
        names: names.map((n) => ({
          name: n.name,
          name_normalized: n.nameNormalized,
          first_seen_at: n.firstSeenAt,
          last_seen_at: n.lastSeenAt,
          observation_count: n.observationCount,
        })),
        ips: ipsVisible
          ? ips.map((ip) => ({
              ip: String(ip.ip),
              first_seen_at: ip.firstSeenAt,
              last_seen_at: ip.lastSeenAt,
            }))
          : [],
        ips_visible: ipsVisible,
      };
    },
  );
  fast.get(
    '/api/v1/players/:steamId/roles',
    {
      config: { permissions: ['user:manage_roles'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req) => {
      const steamId64 = BigInt(req.params.steamId);
      const rows = await app.db
        .select({
          roleId: playerRoleAssignments.roleId,
          roleName: roles.name,
          clearanceLevel: roles.clearanceLevel,
          assignedAt: playerRoleAssignments.assignedAt,
          assignedBy: playerRoleAssignments.assignedBy,
        })
        .from(playerRoleAssignments)
        .innerJoin(roles, eq(roles.id, playerRoleAssignments.roleId))
        .where(eq(playerRoleAssignments.steamId64, steamId64));
      return rows.map((r) => ({
        role_id: r.roleId,
        name: r.roleName,
        clearance_level: r.clearanceLevel,
        assigned_at: r.assignedAt,
        assigned_by: r.assignedBy ? String(r.assignedBy) : null,
      }));
    },
  );

  fast.post(
    '/api/v1/players/:steamId/roles',
    {
      schema: {
        params: playerIdParams,
        body: roleAssignBody,
      },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.assign', resource: 'player' },
      },
    },
    async (req) => {
      const steamId64 = BigInt(req.params.steamId);
      await app.db
        .insert(playerRoleAssignments)
        .values({
          steamId64,
          roleId: req.body.role_id,
          assignedBy: req.user?.steamId64 ?? null,
        })
        .onConflictDoNothing();
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/players/:steamId/roles/:roleId',
    {
      schema: {
        params: playerRoleParams,
      },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.revoke', resource: 'player' },
      },
    },
    async (req, reply) => {
      const steamId64 = BigInt(req.params.steamId);
      const role = await app.db
        .select()
        .from(roles)
        .where(eq(roles.id, req.params.roleId))
        .limit(1);
      if (role[0]?.name === 'Owner') {
        const owners = await app.db
          .select({ steamId64: playerRoleAssignments.steamId64 })
          .from(playerRoleAssignments)
          .where(eq(playerRoleAssignments.roleId, req.params.roleId));
        if (owners.length <= 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }
      await app.db
        .delete(playerRoleAssignments)
        .where(
          and(
            eq(playerRoleAssignments.steamId64, steamId64),
            eq(playerRoleAssignments.roleId, req.params.roleId),
          ),
        );
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/roles',
    {
      config: { permissions: ['user:manage_roles'], audit: false },
    },
    async () => {
      const rows = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          clearanceLevel: roles.clearanceLevel,
          isSystemRole: roles.isSystemRole,
        })
        .from(roles)
        .orderBy(desc(roles.clearanceLevel));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        clearance_level: r.clearanceLevel,
        is_system_role: r.isSystemRole,
      }));
    },
  );
};

export default playerRoutes;
