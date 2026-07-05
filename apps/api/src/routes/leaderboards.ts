import type { StatPeriodType } from '@squad/db';
import { ALLTIME_PERIOD_START, periodStartFor, playerStatPeriods, players } from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { and, asc, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const METRIC_COLUMNS = {
  online: playerStatPeriods.onlineSeconds,
  seeding: playerStatPeriods.seedingSeconds,
  kills: playerStatPeriods.kills,
  deaths: playerStatPeriods.deaths,
  teamkills: playerStatPeriods.teamkills,
  revives: playerStatPeriods.revives,
  kd: playerStatPeriods.kdRatio,
  matches: playerStatPeriods.matchesPlayed,
} as const;

type Metric = keyof typeof METRIC_COLUMNS;

const COMBAT_METRICS = new Set<Metric>(['kills', 'deaths', 'teamkills', 'revives', 'kd']);
const COMBAT_STATS_AVAILABLE = false;
const CACHE_PREFIX = 'leaderboard:';
const CACHE_TTL_SECONDS = 60;
const MAX_LIMIT = 200;
const SEARCH_RATE_LIMIT_PER_MINUTE = 60;
const SEARCH_RATE_LIMIT_PREFIX = 'leaderboard:search-rl:';

const leaderboardsQuery = z.object({
  metric: z.enum(['online', 'seeding', 'kills', 'deaths', 'teamkills', 'revives', 'kd', 'matches']),
  period: z.enum(['day', 'week', 'month', 'season', 'alltime']).default('alltime'),
  period_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  server_id: z.union([z.literal('all'), z.string().uuid()]).default('all'),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  offset: z.coerce.number().int().min(0).default(0),
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

function resolvePeriodStart(period: StatPeriodType, explicit: string | undefined): string {
  if (explicit) return explicit;
  if (period === 'alltime') return ALLTIME_PERIOD_START;
  if (period === 'season') {
    throw new Error('period_start is required for season');
  }
  return periodStartFor(period, new Date().toISOString().slice(0, 10));
}

function buildSearchFilter(search: string): SQL {
  const exactMatch = search.toLowerCase();
  const nameMatch = normalizePlayerName(search);
  const nameHistoryMatch = sql`EXISTS (
    SELECT 1 FROM player_name_history h
    WHERE h.player_id = ${players.id} AND h.name_normalized LIKE ${`%${nameMatch}%`}
  )`;
  const filter = or(
    sql`${players.canonicalNameNormalized} LIKE ${`%${nameMatch}%`}`,
    sql`${players.steamId64}::text = ${exactMatch}`,
    sql`${players.eosId} = ${search}`,
    nameHistoryMatch,
  );
  if (!filter) throw new Error('failed to build search filter');
  return filter;
}

const leaderboardsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/leaderboards',
    {
      schema: {
        tags: ['leaderboards'],
        summary: 'Player leaderboards over materialised stat periods',
        querystring: leaderboardsQuery,
      },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { metric, period, server_id, order, search } = req.query;
      let periodStart: string;
      try {
        periodStart = resolvePeriodStart(period, req.query.period_start);
      } catch {
        reply.code(400);
        return { error: { code: 'invalid_period', message: 'period_start is required' } };
      }

      if (search) {
        const rateKey = `${SEARCH_RATE_LIMIT_PREFIX}${req.ip}:${req.user?.playerId ?? ''}`;
        const hits = await app.redis.incr(rateKey).catch(() => 0);
        if (hits === 1) await app.redis.expire(rateKey, 60).catch(() => {});
        if (hits > SEARCH_RATE_LIMIT_PER_MINUTE) {
          reply.code(429);
          return {
            error: { code: 'rate_limited', message: 'Слишком много запросов поиска.' },
          };
        }
      }

      const perPage = req.query.per_page ?? req.query.limit;
      const limit = perPage;
      const offset =
        req.query.page !== undefined ? (req.query.page - 1) * perPage : req.query.offset;

      const serverFilter =
        server_id === 'all'
          ? isNull(playerStatPeriods.serverId)
          : eq(playerStatPeriods.serverId, server_id);
      const searchFilter = search ? buildSearchFilter(search) : undefined;
      const whereClause = and(
        eq(playerStatPeriods.periodType, period),
        eq(playerStatPeriods.periodStart, periodStart),
        serverFilter,
        searchFilter,
      );

      const cacheKey = `${CACHE_PREFIX}${metric}:${period}:${periodStart}:${server_id}:${order}:${search ?? ''}:${limit}:${offset}`;
      const cached = await app.redis.get(cacheKey).catch(() => null);
      if (cached) {
        reply.header('x-cache', 'hit');
        return reply.send(JSON.parse(cached));
      }

      const metricColumn = METRIC_COLUMNS[metric];
      let rows: Array<{
        playerId: string;
        currentName: string;
        steamId64: bigint | null;
        eosId: string | null;
        metricValue: number;
        onlineSeconds: number;
        seedingSeconds: number;
        kills: number;
        deaths: number;
        kdRatio: number;
        matchesPlayed: number;
      }>;
      let total: number;
      try {
        rows = await app.db
          .select({
            playerId: playerStatPeriods.playerId,
            currentName: players.canonicalName,
            steamId64: players.steamId64,
            eosId: players.eosId,
            metricValue: metricColumn,
            onlineSeconds: playerStatPeriods.onlineSeconds,
            seedingSeconds: playerStatPeriods.seedingSeconds,
            kills: playerStatPeriods.kills,
            deaths: playerStatPeriods.deaths,
            kdRatio: playerStatPeriods.kdRatio,
            matchesPlayed: playerStatPeriods.matchesPlayed,
          })
          .from(playerStatPeriods)
          .innerJoin(players, eq(players.id, playerStatPeriods.playerId))
          .where(whereClause)
          .orderBy(
            order === 'asc' ? asc(metricColumn) : desc(metricColumn),
            asc(playerStatPeriods.playerId),
          )
          .limit(limit)
          .offset(offset);

        const [countRow] = await app.db
          .select({ total: sql<number>`COUNT(*)::int` })
          .from(playerStatPeriods)
          .innerJoin(players, eq(players.id, playerStatPeriods.playerId))
          .where(whereClause);
        total = countRow?.total ?? 0;
      } catch {
        reply.code(500);
        return {
          error: { code: 'internal_error', message: 'Не удалось загрузить таблицу лидеров.' },
        };
      }

      const payload = {
        metric,
        period,
        period_start: periodStart,
        server_id: server_id === 'all' ? null : server_id,
        available: !COMBAT_METRICS.has(metric),
        combat_available: COMBAT_STATS_AVAILABLE,
        total_rows: total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
        rows: rows.map((row, index) => ({
          rank: offset + index + 1,
          player_id: row.playerId,
          current_name: row.currentName,
          steam_id64: row.steamId64 === null ? null : row.steamId64.toString(),
          eos_id: row.eosId,
          metric_value: Number(row.metricValue),
          secondary: {
            online_seconds: row.onlineSeconds,
            seeding_seconds: row.seedingSeconds,
            kills: row.kills,
            deaths: row.deaths,
            kd: Number(row.kdRatio),
            matches_played: row.matchesPlayed,
          },
        })),
      };

      await app.redis
        .set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS)
        .catch(() => {});
      reply.header('x-cache', 'miss');
      return reply.send(payload);
    },
  );
};

export default leaderboardsRoutes;
