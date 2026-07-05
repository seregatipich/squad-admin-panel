import { computePlayerPrimetime } from '@squad/db';
import {
  playerDailyPresence,
  playerIpHistory,
  playerSessions,
  players,
  servers,
} from '@squad/db/schema';
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const PRIMETIME_WINDOW_DAYS = 30;
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

const DAILY_RANGE_DAYS = { '30': 30, '90': 90, '365': 365 } as const;
const dailyPresenceQuery = z.object({
  range: z.enum(['30', '90', '365']).default('30'),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function resolveDailyWindow(
  range: keyof typeof DAILY_RANGE_DAYS,
  endDay: string | undefined,
): { rangeDays: number; fromDay: string; toDay: string } {
  const rangeDays = DAILY_RANGE_DAYS[range];
  const toDay = endDay ?? new Date().toISOString().slice(0, 10);
  const endMidnight = Date.parse(`${toDay}T00:00:00.000Z`);
  const fromDay = new Date(endMidnight - (rangeDays - 1) * DAY_MS).toISOString().slice(0, 10);
  return { rangeDays, fromDay, toDay };
}

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

  fast.get(
    '/api/v1/players/:playerId/presence/daily',
    {
      schema: { params: playerIdParams, querystring: dailyPresenceQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { rangeDays, fromDay, toDay } = resolveDailyWindow(req.query.range, req.query.end);

      const seriesRows = await app.db
        .select({
          day: playerDailyPresence.day,
          online: sql<number>`COALESCE(SUM(${playerDailyPresence.onlineSeconds}), 0)::int`,
          boost: sql<number>`COALESCE(SUM(${playerDailyPresence.boostSeconds}), 0)::int`,
          queue: sql<number>`COALESCE(SUM(${playerDailyPresence.queueSeconds}), 0)::int`,
        })
        .from(playerDailyPresence)
        .where(
          and(
            eq(playerDailyPresence.playerId, playerId),
            gte(playerDailyPresence.day, fromDay),
            lte(playerDailyPresence.day, toDay),
          ),
        )
        .groupBy(playerDailyPresence.day)
        .orderBy(asc(playerDailyPresence.day));

      const [playerRow] = await app.db
        .select({ total: players.totalTimePlayedSeconds })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);

      const [openSession] = await app.db
        .select({ connectedAt: playerSessions.connectedAt })
        .from(playerSessions)
        .where(and(eq(playerSessions.playerId, playerId), isNull(playerSessions.disconnectedAt)))
        .orderBy(asc(playerSessions.connectedAt))
        .limit(1);

      return {
        range: rangeDays,
        from: fromDay,
        to: toDay,
        total_time_played_seconds: playerRow?.total ?? 0,
        live: openSession
          ? { online: true, since: openSession.connectedAt.toISOString() }
          : { online: false, since: null },
        series: seriesRows.map((row) => ({
          day: row.day,
          online_seconds: row.online,
          boost_seconds: row.boost,
          queue_seconds: row.queue,
        })),
      };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/primetime',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const now = new Date();
      const windowEndMs = now.getTime();
      const windowStartMs = windowEndMs - PRIMETIME_WINDOW_DAYS * DAY_MS;
      const windowStart = new Date(windowStartMs);
      const windowEnd = new Date(windowEndMs);

      const [geoRow] = await app.db
        .select({ timezone: playerIpHistory.timezoneOffset })
        .from(playerIpHistory)
        .where(
          and(eq(playerIpHistory.playerId, playerId), isNotNull(playerIpHistory.timezoneOffset)),
        )
        .orderBy(desc(playerIpHistory.lastSeenAt))
        .limit(1);

      const sessionRows = await app.db
        .select({
          connectedAt: playerSessions.connectedAt,
          disconnectedAt: playerSessions.disconnectedAt,
        })
        .from(playerSessions)
        .where(
          and(
            eq(playerSessions.playerId, playerId),
            lt(playerSessions.connectedAt, windowEnd),
            or(
              isNull(playerSessions.disconnectedAt),
              gt(playerSessions.disconnectedAt, windowStart),
            ),
          ),
        )
        .orderBy(asc(playerSessions.connectedAt))
        .limit(SESSION_WINDOW_CAP);

      const timezone = geoRow?.timezone ?? null;
      const result = computePlayerPrimetime({
        sessions: sessionRows,
        timezone,
        windowStartMs,
        windowEndMs,
        nowMs: windowEndMs,
      });

      return {
        window: {
          from: windowStart.toISOString().slice(0, 10),
          to: windowEnd.toISOString().slice(0, 10),
          days: PRIMETIME_WINDOW_DAYS,
        },
        timezone,
        offset_minutes: result.offsetMinutes,
        total_seconds: result.totalSeconds,
        histogram: result.histogram,
        rolling_average: result.rollingAverage.map((value) => Math.round(value)),
        primetime: result.range
          ? {
              label: result.range.label,
              start_minutes: result.range.startMinutes,
              end_minutes: result.range.endMinutes,
              start_hour: result.range.startHour,
              end_hour: result.range.endHour,
            }
          : null,
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
