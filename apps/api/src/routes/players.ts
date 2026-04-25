import { playerIpHistory, playerNameHistory, players, roles } from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { invalidatePermissionCache } from '../lib/rbac.js';

const playerIdParams = z.object({ steamId: z.string().regex(/^\d{17}$/) });
const roleAssignBody = z.object({ role_id: z.string().uuid().nullable() });

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
    '/api/v1/players/:steamId/role',
    {
      config: { permissions: ['user:view'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req) => {
      const id = BigInt(req.params.steamId);
      type RoleRow = {
        role_id: string | null;
        role_name: string | null;
        role_color: string | null;
        role_is_system: boolean | null;
      };
      const rows = await app.db.execute<RoleRow>(sql`
        SELECT r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system
        FROM players p LEFT JOIN roles r ON r.id = p.role_id
        WHERE p.steam_id64 = ${id}
      `);
      const r = (rows as unknown as RoleRow[])[0];
      if (!r?.role_id) return { role: null };
      return {
        role: {
          id: r.role_id,
          name: r.role_name,
          color: r.role_color,
          is_system_role: r.role_is_system,
        },
      };
    },
  );

  fast.put(
    '/api/v1/players/:steamId/role',
    {
      schema: { params: playerIdParams, body: roleAssignBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.assign', resource: 'player' },
      },
    },
    async (req, reply) => {
      const steamId64 = BigInt(req.params.steamId);
      const newRoleId = req.body.role_id;

      if (newRoleId !== null) {
        const exists = await app.db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.id, newRoleId))
          .limit(1);
        if (exists.length === 0) {
          reply.code(404);
          return { error: 'role_not_found' };
        }
      }

      const ownerRow = await app.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
        .limit(1);
      const ownerId = ownerRow[0]?.id ?? null;

      const current = await app.db
        .select({ roleId: players.roleId })
        .from(players)
        .where(eq(players.steamId64, steamId64))
        .limit(1);
      const wasOwner = current[0]?.roleId === ownerId && ownerId !== null;
      const willBeOwner = newRoleId === ownerId && ownerId !== null;

      if (wasOwner && !willBeOwner) {
        const ownerCount = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, ownerId));
        if ((ownerCount[0]?.c ?? 0) <= 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }

      await app.db
        .update(players)
        .set({ roleId: newRoleId })
        .where(eq(players.steamId64, steamId64));
      invalidatePermissionCache(steamId64);
      return { ok: true };
    },
  );
};

export default playerRoutes;
