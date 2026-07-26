import { economySettings, playerBonusAccruals, players } from '@squad/db';
import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const CACHE_PREFIX = 'leaderboard-bonuses:';
const CACHE_TTL_SECONDS = 60;
const MAX_LIMIT = 200;

const bonusesQuery = z.object({
  period: z.enum(['all', '30d']).default('all'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
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

interface BonusRow {
  playerId: string;
  currentName: string;
  steamId64: bigint | null;
  eosId: string | null;
  value: number;
  onlineSeconds: number;
}

/**
 * ECON-5 (#165): bonus leaderboard.
 *
 * `period=all` ranks straight off `players.bonus_balance` (served by
 * `players_bonus_balance_desc_idx`); `period=30d` ranks by the precomputed
 * rolling accrual window in `player_bonus_accruals`, rebuilt by the
 * leaderboard-aggregator tick. Zero-balance players are not ranked. EOS-only
 * players (no steam_id64) are included — there is no steam filter.
 */
const leaderboardsBonusesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/leaderboards/bonuses',
    {
      schema: {
        tags: ['leaderboards'],
        summary: 'Bonus leaderboard: all-time balance or the rolling 30-day accrual window',
        querystring: bonusesQuery,
      },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { period, limit } = req.query;

      const [economyRow] = await app.db
        .select({ enabled: economySettings.economyEnabled })
        .from(economySettings)
        .limit(1);
      const economyEnabled = economyRow?.enabled ?? false;
      if (!economyEnabled) {
        return reply.send({
          period,
          available: false,
          economy_enabled: false,
          total_rows: 0,
          rows: [],
        });
      }

      const cacheKey = `${CACHE_PREFIX}${period}:${limit}`;
      const cached = await app.redis.get(cacheKey).catch(() => null);
      if (cached) {
        reply.header('x-cache', 'hit');
        return reply.send(JSON.parse(cached));
      }

      let rows: BonusRow[];
      let total: number;
      try {
        if (period === 'all') {
          rows = await app.db
            .select({
              playerId: players.id,
              currentName: players.canonicalName,
              steamId64: players.steamId64,
              eosId: players.eosId,
              value: players.bonusBalance,
              onlineSeconds: players.totalTimePlayedSeconds,
            })
            .from(players)
            .where(gt(players.bonusBalance, 0))
            .orderBy(desc(players.bonusBalance), asc(players.id))
            .limit(limit);
          const [countRow] = await app.db
            .select({ total: sql<number>`COUNT(*)::int` })
            .from(players)
            .where(gt(players.bonusBalance, 0));
          total = countRow?.total ?? 0;
        } else {
          rows = await app.db
            .select({
              playerId: playerBonusAccruals.playerId,
              currentName: players.canonicalName,
              steamId64: players.steamId64,
              eosId: players.eosId,
              value: playerBonusAccruals.accrued30d,
              onlineSeconds: players.totalTimePlayedSeconds,
            })
            .from(playerBonusAccruals)
            .innerJoin(players, eq(players.id, playerBonusAccruals.playerId))
            .orderBy(desc(playerBonusAccruals.accrued30d), asc(playerBonusAccruals.playerId))
            .limit(limit);
          const [countRow] = await app.db
            .select({ total: sql<number>`COUNT(*)::int` })
            .from(playerBonusAccruals);
          total = countRow?.total ?? 0;
        }
      } catch {
        reply.code(500);
        return {
          error: { code: 'internal_error', message: 'Не удалось загрузить лидерборд бонусов.' },
        };
      }

      const payload = {
        period,
        available: true,
        economy_enabled: true,
        total_rows: total,
        rows: rows.map((row, index) => ({
          rank: index + 1,
          player_id: row.playerId,
          current_name: row.currentName,
          steam_id64: row.steamId64 === null ? null : row.steamId64.toString(),
          eos_id: row.eosId,
          value: Number(row.value),
          online_seconds: Number(row.onlineSeconds),
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

export default leaderboardsBonusesRoutes;
