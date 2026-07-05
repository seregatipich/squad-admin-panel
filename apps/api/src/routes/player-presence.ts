import { playerDailyPresence, playerSessions, servers } from '@squad/db/schema';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const SESSION_WINDOW_CAP = 2000;
const ONLINE_STATUS_CAP = 1000;
const BONUS_FORMULA_LABEL = 'online + 2×boost';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const presenceQuery = z.object({
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function resolveWindow(endDay: string | undefined): {
  endDay: string;
  weekStart: Date;
  weekEnd: Date;
} {
  const resolvedEnd = endDay ?? new Date().toISOString().slice(0, 10);
  const endMidnight = Date.parse(`${resolvedEnd}T00:00:00.000Z`);
  return {
    endDay: resolvedEnd,
    weekStart: new Date(endMidnight - (WEEK_DAYS - 1) * DAY_MS),
    weekEnd: new Date(endMidnight + DAY_MS),
  };
}

const playerPresenceRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/presence',
    { schema: { params: playerIdParams, querystring: presenceQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { weekStart, weekEnd, endDay } = resolveWindow(req.query.end);

      const serverRows = await app.db
        .select({
          serverId: playerDailyPresence.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          online: sql<number>`COALESCE(SUM(${playerDailyPresence.onlineSeconds}), 0)::int`,
          boost: sql<number>`COALESCE(SUM(${playerDailyPresence.boostSeconds}), 0)::int`,
          queue: sql<number>`COALESCE(SUM(${playerDailyPresence.queueSeconds}), 0)::int`,
          sessionCount: sql<number>`COALESCE(SUM(${playerDailyPresence.sessionCount}), 0)::int`,
        })
        .from(playerDailyPresence)
        .leftJoin(servers, eq(servers.id, playerDailyPresence.serverId))
        .where(eq(playerDailyPresence.playerId, playerId))
        .groupBy(playerDailyPresence.serverId, servers.displayName, servers.slug);

      const byServer = serverRows
        .map((row) => ({
          server_id: row.serverId,
          server_name: row.serverName,
          server_slug: row.serverSlug,
          online_seconds: row.online,
          boost_seconds: row.boost,
          queue_seconds: row.queue,
          session_count: row.sessionCount,
        }))
        .sort((a, b) => b.online_seconds - a.online_seconds);

      const totals = byServer.reduce(
        (acc, row) => ({
          online_seconds: acc.online_seconds + row.online_seconds,
          boost_seconds: acc.boost_seconds + row.boost_seconds,
          queue_seconds: acc.queue_seconds + row.queue_seconds,
        }),
        { online_seconds: 0, boost_seconds: 0, queue_seconds: 0 },
      );

      const sessionRows = await app.db
        .select({
          id: playerSessions.id,
          serverId: playerSessions.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          mode: playerSessions.mode,
          connectedAt: playerSessions.connectedAt,
          disconnectedAt: playerSessions.disconnectedAt,
        })
        .from(playerSessions)
        .leftJoin(servers, eq(servers.id, playerSessions.serverId))
        .where(
          and(
            eq(playerSessions.playerId, playerId),
            lt(playerSessions.connectedAt, weekEnd),
            or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, weekStart)),
          ),
        )
        .orderBy(asc(playerSessions.connectedAt))
        .limit(SESSION_WINDOW_CAP);

      const sessions = sessionRows.map((row) => ({
        id: row.id.toString(),
        server_id: row.serverId,
        server_name: row.serverName,
        server_slug: row.serverSlug,
        mode: row.mode,
        connected_at: row.connectedAt.toISOString(),
        disconnected_at: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
      }));

      return {
        totals,
        bonus: {
          formula: BONUS_FORMULA_LABEL,
          value_seconds: totals.online_seconds + 2 * totals.boost_seconds,
        },
        by_server: byServer,
        sessions,
        week: { from: weekStart.toISOString().slice(0, 10), to: endDay },
      };
    },
  );

  fast.get('/api/v1/players/online-status', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;

    const rows = await app.db
      .selectDistinct({ playerId: playerSessions.playerId })
      .from(playerSessions)
      .where(isNull(playerSessions.disconnectedAt))
      .limit(ONLINE_STATUS_CAP);

    return { online_player_ids: rows.map((row) => row.playerId) };
  });
};

export default playerPresenceRoutes;
