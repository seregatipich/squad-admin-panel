import {
  clanMembers,
  clans,
  geoipSettings,
  playerIpHistory,
  playerNameHistory,
  players,
  roles,
} from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { and, asc, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { publishDiscordRoleSync } from '../lib/discord-role-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const roleAssignBody = z.object({
  role_id: z.string().uuid().nullable(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  comment: z.string().trim().max(512).nullable().optional(),
});
const PLAYER_SORTS = ['nickname', 'last_seen', 'created', 'total_time'] as const;
const listQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  sort: z.enum(PLAYER_SORTS).default('last_seen'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  filter: z.enum(['new']).optional(),
});
const searchQuery = z.object({ q: z.string().trim().min(3).max(64) });

interface PlayerSearchRow {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  last_seen_at: string | null;
  clan_id: string | null;
  clan_name: string | null;
}

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

/** Maps a `?sort=` key from {@link PLAYER_SORTS} to the column it orders by. */
function playerSortColumn(sort: (typeof PLAYER_SORTS)[number]) {
  if (sort === 'nickname') return players.canonicalNameNormalized;
  if (sort === 'created') return players.firstSeenAt;
  if (sort === 'total_time') return players.totalTimePlayedSeconds;
  return players.lastSeenAt;
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
      const clauses: SQL[] = [];
      if (q) {
        const exactMatch = q.toLowerCase();
        const nameMatch = normalizePlayerName(q);
        const nameHistoryMatch = sql`EXISTS (
          SELECT 1 FROM player_name_history h
          WHERE h.player_id = players.id AND h.name_normalized LIKE ${`%${nameMatch}%`}
        )`;
        const searchClause = or(
          sql`canonical_name_normalized LIKE ${`%${nameMatch}%`}`,
          sql`steam_id64::text = ${exactMatch}`,
          sql`eos_id = ${exactMatch}`,
          nameHistoryMatch,
        );
        if (searchClause) clauses.push(searchClause);
      }
      if (req.query.filter === 'new') {
        clauses.push(sql`first_seen_at >= now() - interval '7 days'`);
      }
      const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
      const sortedColumn = playerSortColumn(req.query.sort);
      const rows = await app.db
        .select()
        .from(players)
        .where(whereClause)
        .orderBy(req.query.dir === 'asc' ? asc(sortedColumn) : desc(sortedColumn), asc(players.id))
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
    '/api/v1/players/search',
    { schema: { querystring: searchQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const q = req.query.q.trim();
      const exactMatch = q.toLowerCase();
      const nameMatch = normalizePlayerName(q);
      const rows = (await app.db.execute(sql`
        SELECT p.id, p.steam_id64::text AS steam_id64, p.canonical_name, p.eos_id,
               p.last_seen_at::text AS last_seen_at,
               cm.clan_id, c.name AS clan_name
        FROM players p
        LEFT JOIN clan_members cm ON cm.player_id = p.id
        LEFT JOIN clans c ON c.id = cm.clan_id AND c.deleted_at IS NULL
        WHERE p.canonical_name_normalized LIKE ${`%${nameMatch}%`}
           OR p.steam_id64::text = ${exactMatch}
           OR p.eos_id = ${exactMatch}
           OR EXISTS (
             SELECT 1 FROM player_name_history h
             WHERE h.player_id = p.id AND h.name_normalized LIKE ${`%${nameMatch}%`}
           )
        ORDER BY p.last_seen_at DESC
        LIMIT 25
      `)) as unknown as PlayerSearchRow[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          steam_id64: row.steam_id64,
          canonical_name: row.canonical_name,
          eos_id: row.eos_id,
          last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
          clan_id: row.clan_id,
          clan_name: row.clan_name,
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

      // ALT-8 (#126): IP history requires the dedicated player:view_ips
      // permission (gated by the role's can_view_ips flag), not just
      // panel_access — panel_access alone no longer implies IP visibility.
      const ipsVisible = req.user?.permissions.permissions.has('player:view_ips') ?? false;

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

      const [clanMembership] = await app.db
        .select({
          clanId: clans.id,
          clanName: clans.name,
          clanTags: clans.tags,
          memberRole: clanMembers.memberRole,
        })
        .from(clanMembers)
        .innerJoin(clans, and(eq(clans.id, clanMembers.clanId), isNull(clans.deletedAt)))
        .where(eq(clanMembers.playerId, id))
        .limit(1);

      return {
        player: {
          id: row.id,
          steam_id64: row.steamId64 ? row.steamId64.toString() : null,
          canonical_name: row.canonicalName,
          eos_id: row.eosId,
          first_seen_at: row.firstSeenAt,
          last_seen_at: row.lastSeenAt,
          total_time_played_seconds: Number(row.totalTimePlayedSeconds),
          // INT-1 (#76): stored Steam Web API snapshot. Everything here stays
          // null/zero until POST /api/v1/players/:playerId/steam-refresh runs.
          avatar_url: row.avatarUrl,
          persona_name: row.personaName,
          profile_visibility: row.profileVisibility,
          steam_account_created_at: row.steamAccountCreatedAt,
          vac_banned: row.vacBanned,
          vac_ban_count: row.vacBanCount,
          game_ban_count: row.gameBanCount,
          days_since_last_ban: row.daysSinceLastBan,
          owns_squad: row.ownsSquad,
          steam_playtime_minutes: row.steamPlaytimeMinutes,
          steam_checked_at: row.steamCheckedAt,
        },
        clan: clanMembership
          ? {
              id: clanMembership.clanId,
              name: clanMembership.clanName,
              tags: clanMembership.clanTags,
              member_role: clanMembership.memberRole,
            }
          : null,
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
        role_expires_at: string | null;
        role_comment: string | null;
      };
      const rows = await app.db.execute<RoleRow>(sql`
        SELECT r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system,
               p.role_expires_at::text AS role_expires_at,
               p.role_comment AS role_comment
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
          role_expires_at: r.role_expires_at ? new Date(r.role_expires_at).toISOString() : null,
          role_comment: r.role_comment,
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
      const roleExpiresAt = req.body.expires_at ? new Date(req.body.expires_at) : null;
      const comment = req.body.comment?.trim() ?? null;
      const roleComment = comment === '' ? null : comment;

      if (roleExpiresAt && roleExpiresAt <= new Date()) {
        reply.code(400);
        return { error: 'role_expiry_must_be_future' };
      }

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
        await tx
          .update(players)
          .set({
            roleId: newRoleId,
            roleExpiresAt: newRoleId === null ? null : roleExpiresAt,
            roleComment: newRoleId === null ? null : roleComment,
          })
          .where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: newRoleId === null ? 'player.role.unassign' : 'player.role.assign',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);
      // DISCORD-5 (#152): published after the commit so worker-discord re-derives
      // this player's Discord roles within seconds. Best-effort — the worker's
      // hourly reconcile is the durability backstop.
      await publishDiscordRoleSync(
        app.redis,
        playerId,
        newRoleId === null ? 'player.role.unassign' : 'player.role.assign',
        app.log,
      );

      if (!newRolePanelAccess) {
        await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
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
        await tx
          .update(players)
          .set({ roleId: null, roleExpiresAt: null, roleComment: null })
          .where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'player.role.unassign',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);
      await publishDiscordRoleSync(app.redis, playerId, 'player.role.unassign', app.log);
      await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      return { ok: true };
    },
  );
};

export default playerRoutes;
