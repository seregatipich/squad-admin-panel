import { clanMembers, players } from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clanAccess } from '../../lib/clans/access.js';
import { clanIdParams, RESERVE_SQUAD_PERMISSION_KEY } from '../../lib/clans/common.js';
import { csvCell } from '../../lib/csv.js';
import { steamId64Equals } from '../../lib/player-search.js';
import { requestUser } from '../../lib/request-user.js';
import { escapeLike } from '../../lib/sql-like.js';

const rosterQuery = z.object({
  q: z.string().trim().min(1).max(64).optional(),
  sort: z
    .enum(['name', 'role', 'priority', 'joined_at', 'last_seen', 'online'])
    .default('joined_at'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const rosterExportQuery = z.object({ format: z.literal('csv').default('csv') });

interface RosterRow {
  player_id: string;
  member_role: string;
  has_priority: boolean;
  joined_at: string;
  canonical_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  last_seen_at: string | null;
  online_60d: number;
  reserve_from_role: boolean;
}

/** Paginated clan roster and its CSV export. */
const clanRosterRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan, clanManageLevel } = clanAccess(app);

  fast.get(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, querystring: rosterQuery }, config: { audit: false } },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const { q, sort, order, page, limit } = req.query;
      const offset = (page - 1) * limit;

      const filters = [sql`cm.clan_id = ${clan.id}`];
      if (q) {
        const nameMatch = normalizePlayerName(q);
        const exactMatch = q.toLowerCase();
        filters.push(
          sql`(p.canonical_name_normalized LIKE ${`%${escapeLike(nameMatch)}%`} OR ${steamId64Equals(sql`p.steam_id64`, q.trim())} OR p.eos_id = ${exactMatch})`,
        );
      }
      const whereSql = and(...filters);

      const sortColumn = {
        name: sql`p.canonical_name`,
        role: sql`cm.member_role`,
        priority: sql`cm.has_priority`,
        joined_at: sql`cm.joined_at`,
        last_seen: sql`p.last_seen_at`,
        online: sql`online_60d`,
      }[sort];
      const direction = order === 'asc' ? sql`ASC` : sql`DESC`;

      const rows = (await app.db.execute(sql`
        SELECT cm.player_id, cm.member_role, cm.has_priority,
               cm.joined_at::text AS joined_at,
               p.canonical_name, p.steam_id64::text AS steam_id64, p.eos_id,
               p.last_seen_at::text AS last_seen_at,
               COALESCE(pres.online, 0)::int AS online_60d,
               EXISTS (
                 SELECT 1 FROM role_squad_permissions rsp
                 WHERE rsp.role_id = p.role_id AND rsp.squad_permission_key = ${RESERVE_SQUAD_PERMISSION_KEY}
               ) AS reserve_from_role
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        -- Per-member lookup through the (player_id, day, server_id) key, so the
        -- cost follows the roster size, not the whole server's 60-day
        -- presence (audit #127).
        LEFT JOIN LATERAL (
          SELECT SUM(pdp.online_seconds) AS online
          FROM player_daily_presence pdp
          WHERE pdp.player_id = cm.player_id
            AND pdp.day >= (CURRENT_DATE - INTERVAL '60 days')
        ) pres ON true
        WHERE ${whereSql}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, cm.joined_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as RosterRow[];

      const countRows = (await app.db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        WHERE ${whereSql}
      `)) as unknown as Array<{ total: number }>;
      const total = countRows[0]?.total ?? 0;

      const priorityCountRows = (await app.db.execute(sql`
        SELECT COUNT(*)::int AS priority_count
        FROM clan_members cm
        WHERE cm.clan_id = ${clan.id} AND cm.has_priority
      `)) as unknown as Array<{ priority_count: number }>;
      const priorityCount = priorityCountRows[0]?.priority_count ?? 0;

      // The viewer's own manage level, computed server-side the same way the
      // mutating routes below gate themselves — never derived by the client
      // from searching this same paginated/sorted page for the viewer's own
      // row, which can (and, once searched/sorted/paged, routinely does) fall
      // off it (#509).
      const viewerManageLevel = await clanManageLevel(clan.id, requestUser(req));

      return {
        clan_id: clan.id,
        priority_count: priorityCount,
        max_priority_slots: clan.maxPrioritySlots,
        viewer_manage_level: viewerManageLevel,
        items: rows.map((row) => ({
          player_id: row.player_id,
          canonical_name: row.canonical_name,
          steam_id64: row.steam_id64,
          eos_id: row.eos_id,
          member_role: row.member_role,
          has_priority: row.has_priority,
          reserve_from_role: row.reserve_from_role,
          joined_at: new Date(row.joined_at).toISOString(),
          last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
          online_60d_seconds: Number(row.online_60d),
        })),
        total,
        page,
        limit,
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id/roster/export',
    { schema: { params: clanIdParams, querystring: rosterExportQuery }, config: { audit: false } },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const rows = await app.db
        .select({
          canonicalName: players.canonicalName,
          steamId64: players.steamId64,
          memberRole: clanMembers.memberRole,
          hasPriority: clanMembers.hasPriority,
          joinedAt: clanMembers.joinedAt,
          lastSeenAt: players.lastSeenAt,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt));

      const lines = [
        'canonical_name,steam_id64,member_role,has_priority,joined_at,last_seen_at',
        ...rows.map((row) =>
          [
            csvCell(row.canonicalName),
            row.steamId64 ? row.steamId64.toString() : '',
            row.memberRole,
            row.hasPriority ? 'true' : 'false',
            row.joinedAt.toISOString(),
            row.lastSeenAt ? row.lastSeenAt.toISOString() : '',
          ].join(','),
        ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="clan-${clan.id}-roster-${stamp}.csv"`,
      );
      return body;
    },
  );
};

export default clanRosterRoutes;
