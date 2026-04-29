import { playerIpHistory, playerNameHistory, players, roles } from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const playerIdParams = z.object({ steamId: z.string().regex(/^\d{17}$/) });
const roleAssignBody = z.object({ role_id: z.string().uuid().nullable() });
const listQuery = z.object({ q: z.string().min(1).max(64).optional() });

const playerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req) => {
      const q = req.query.q?.toLowerCase().trim();
      const whereClause = q
        ? sql`canonical_name_normalized LIKE ${`%${q}%`} OR steam_id64::text = ${q}`
        : undefined;
      const rows = await app.db
        .select()
        .from(players)
        .where(whereClause)
        .orderBy(desc(players.lastSeenAt))
        .limit(200);
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

      let newRolePanelAccess = false;
      if (newRoleId !== null) {
        const exists = await app.db
          .select({
            id: roles.id,
            isSystemRole: roles.isSystemRole,
            name: roles.name,
            panelAccess: roles.panelAccess,
          })
          .from(roles)
          .where(eq(roles.id, newRoleId))
          .limit(1);
        if (exists.length === 0) {
          reply.code(404);
          return { error: 'role_not_found' };
        }
        // biome-ignore lint/style/noNonNullAssertion: guarded by length check
        const target = exists[0]!;
        // 2.6.4 — Owner cannot be assigned via UI; only the first-login
        // trick or direct DB modification can grant Owner.
        if (target.isSystemRole && target.name === 'Owner') {
          reply.code(403);
          return { error: 'owner_assignment_forbidden' };
        }
        newRolePanelAccess = target.panelAccess;
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

      await app.db.transaction(async (tx) => {
        await tx.update(players).set({ roleId: newRoleId }).where(eq(players.steamId64, steamId64));
        // Spec §2.7.1 — sync-task is enqueued in the same transaction
        // as the player.role mutation so a Redis failure aborts the DB
        // write and keeps the file/DB invariant.
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: newRoleId === null ? 'player.role.unassign' : 'player.role.assign',
          actor_steam_id64: req.user?.steamId64 ? String(req.user.steamId64) : null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(steamId64);

      // 2.6.1 — if the player just lost panel_access, kill all live
      // sessions so the next request bounces them to /login.
      if (!newRolePanelAccess) {
        await revokeAllForPlayer(app.db, app.redis, steamId64);
      }
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/players/:steamId/role',
    {
      schema: { params: playerIdParams },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.unassign', resource: 'player' },
      },
    },
    async (req, reply) => {
      const steamId64 = BigInt(req.params.steamId);
      // Self-protect last Owner.
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
      if (current.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      const wasOwner = current[0]?.roleId === ownerId && ownerId !== null;
      if (wasOwner) {
        const ownerCount = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, ownerId));
        if ((ownerCount[0]?.c ?? 0) <= 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }
      await app.db.transaction(async (tx) => {
        await tx.update(players).set({ roleId: null }).where(eq(players.steamId64, steamId64));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'player.role.unassign',
          actor_steam_id64: req.user?.steamId64 ? String(req.user.steamId64) : null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(steamId64);
      await revokeAllForPlayer(app.db, app.redis, steamId64);
      return { ok: true };
    },
  );
};

export default playerRoutes;
