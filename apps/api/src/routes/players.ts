import {
  geoipSettings,
  playerIpHistory,
  playerNameHistory,
  players,
  roles,
} from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { and, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const roleAssignBody = z.object({ role_id: z.string().uuid().nullable() });
const listQuery = z.object({ q: z.string().min(1).max(64).optional() });

interface CountryRow {
  countryCode: string | null;
  countryName: string | null;
  lastSeenAt: Date;
}

function dedupeCountries(rows: CountryRow[]): Array<{
  country_code: string;
  country_name: string | null;
  last_seen_at: Date;
}> {
  const seen = new Map<
    string,
    { country_code: string; country_name: string | null; last_seen_at: Date }
  >();
  for (const row of rows) {
    if (!row.countryCode) continue;
    if (seen.has(row.countryCode)) continue;
    seen.set(row.countryCode, {
      country_code: row.countryCode,
      country_name: row.countryName,
      last_seen_at: row.lastSeenAt,
    });
  }
  return [...seen.values()];
}

const playerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req) => {
      const q = req.query.q?.trim();
      let whereClause: SQL | undefined;
      if (q) {
        const exactMatch = q.toLowerCase();
        const nameMatch = normalizePlayerName(q);
        const nameHistoryMatch = sql`EXISTS (
          SELECT 1 FROM player_name_history h
          WHERE h.player_id = players.id AND h.name_normalized LIKE ${`%${nameMatch}%`}
        )`;
        whereClause = or(
          sql`canonical_name_normalized LIKE ${`%${nameMatch}%`}`,
          sql`steam_id64::text = ${exactMatch}`,
          sql`eos_id = ${exactMatch}`,
          nameHistoryMatch,
        );
      }
      const rows = await app.db
        .select()
        .from(players)
        .where(whereClause)
        .orderBy(desc(players.lastSeenAt))
        .limit(200);
      return {
        items: rows.map((r) => ({
          id: r.id,
          steam_id64: r.steamId64 ? r.steamId64.toString() : null,
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
    '/api/v1/players/:playerId',
    {
      config: { permissions: ['player:view'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req, reply) => {
      const id = req.params.playerId;
      const row = await app.db.query.players.findFirst({
        where: eq(players.id, id),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const names = await app.db
        .select()
        .from(playerNameHistory)
        .where(eq(playerNameHistory.playerId, id))
        .orderBy(desc(playerNameHistory.lastSeenAt));

      // P0 gate = panel_access (spec correction #3): every panel-access role
      // sees IPs + precise location; legacy narrow roles (Viewer) do not.
      const ipsVisible = req.user?.permissions.panelAccess ?? false;

      const ipRows = await app.db
        .select()
        .from(playerIpHistory)
        .where(eq(playerIpHistory.playerId, id))
        .orderBy(desc(playerIpHistory.lastSeenAt));

      const [geoSettings] = await app.db
        .select({ enabled: geoipSettings.enabled })
        .from(geoipSettings)
        .limit(1);
      const geoConfigured = geoSettings?.enabled ?? false;

      const locations = dedupeCountries(ipRows);

      return {
        player: {
          id: row.id,
          steam_id64: row.steamId64 ? row.steamId64.toString() : null,
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
          ? ipRows.map((ip) => ({
              ip: String(ip.ip),
              country_code: ip.countryCode,
              country_name: ip.countryName,
              region: ip.region,
              city: ip.city,
              timezone_offset: ip.timezoneOffset,
              latitude: ip.latitude,
              longitude: ip.longitude,
              first_seen_at: ip.firstSeenAt,
              last_seen_at: ip.lastSeenAt,
              observation_count: ip.observationCount,
            }))
          : [],
        locations,
        ips_visible: ipsVisible,
        geo_configured: geoConfigured,
      };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/role',
    {
      config: { permissions: ['user:view'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req) => {
      const id = req.params.playerId;
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
        WHERE p.id = ${id}
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
    '/api/v1/players/:playerId/role',
    {
      schema: { params: playerIdParams, body: roleAssignBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.assign', resource: 'player' },
      },
    },
    async (req, reply) => {
      const playerId = req.params.playerId;
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
        .where(eq(players.id, playerId))
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
        await tx.update(players).set({ roleId: newRoleId }).where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: newRoleId === null ? 'player.role.unassign' : 'player.role.assign',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);

      if (!newRolePanelAccess) {
        await revokeAllForPlayer(app.db, app.redis, playerId);
      }
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/players/:playerId/role',
    {
      schema: { params: playerIdParams },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'player.role.unassign', resource: 'player' },
      },
    },
    async (req, reply) => {
      const playerId = req.params.playerId;
      const ownerRow = await app.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
        .limit(1);
      const ownerId = ownerRow[0]?.id ?? null;
      const current = await app.db
        .select({ roleId: players.roleId })
        .from(players)
        .where(eq(players.id, playerId))
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
        await tx.update(players).set({ roleId: null }).where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'player.role.unassign',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);
      await revokeAllForPlayer(app.db, app.redis, playerId);
      return { ok: true };
    },
  );
};

export default playerRoutes;
