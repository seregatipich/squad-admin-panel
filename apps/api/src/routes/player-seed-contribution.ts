import { bonusTransactions, economySettings, playerDailyPresence, servers } from '@squad/db/schema';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;
/** Mirrors `economy_settings.k_seed`'s column default (settings-economy.ts DEFAULT_SETTINGS). */
const DEFAULT_K_SEED = 3;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const seedContributionQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(MIN_WINDOW_DAYS)
    .max(MAX_WINDOW_DAYS)
    .default(DEFAULT_WINDOW_DAYS),
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

function resolveWindow(days: number): { fromDay: string; toDay: string } {
  const toDay = new Date().toISOString().slice(0, 10);
  const toMidnight = Date.parse(`${toDay}T00:00:00.000Z`);
  const fromDay = new Date(toMidnight - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { fromDay, toDay };
}

/**
 * Read surface for a player's seed contribution (SEED-2, #141): aggregates
 * `player_daily_presence.seed_seconds` — attributed by the daily accrual job
 * (`packages/db/src/economy/accrual.ts`) from the intersection of the
 * player's sessions with each server's SEED-1 (#140) seeding windows, or the
 * legacy concurrency-threshold sweep for servers with no seeding events — over
 * a rolling window, and the `earn_seed` bonus points the economy ledger paid
 * out for that window.
 */
const playerSeedContributionRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/seed-contribution',
    {
      schema: { params: playerIdParams, querystring: seedContributionQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { days } = req.query;
      const { fromDay, toDay } = resolveWindow(days);

      const [settingsRow] = await app.db
        .select({ kSeed: economySettings.kSeed })
        .from(economySettings)
        .where(eq(economySettings.id, 1))
        .limit(1);
      const kSeed = settingsRow?.kSeed ?? DEFAULT_K_SEED;

      const byServerRows = await app.db
        .select({
          serverId: playerDailyPresence.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          seedSeconds: sql<number>`COALESCE(SUM(${playerDailyPresence.seedSeconds}), 0)::int`,
        })
        .from(playerDailyPresence)
        .leftJoin(servers, eq(servers.id, playerDailyPresence.serverId))
        .where(
          and(
            eq(playerDailyPresence.playerId, playerId),
            gte(playerDailyPresence.day, fromDay),
            lte(playerDailyPresence.day, toDay),
          ),
        )
        .groupBy(playerDailyPresence.serverId, servers.displayName, servers.slug);

      const byServer = byServerRows
        .map((row) => ({
          server_id: row.serverId,
          server_name: row.serverName,
          server_slug: row.serverSlug,
          seed_seconds: row.seedSeconds,
        }))
        .sort((a, b) => b.seed_seconds - a.seed_seconds);

      const totalSeedSeconds = byServer.reduce((acc, row) => acc + row.seed_seconds, 0);

      const seriesRows = await app.db
        .select({
          day: playerDailyPresence.day,
          seedSeconds: sql<number>`COALESCE(SUM(${playerDailyPresence.seedSeconds}), 0)::int`,
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

      const series = seriesRows.map((row) => ({ day: row.day, seed_seconds: row.seedSeconds }));

      const [bonusRow] = await app.db
        .select({ earned: sql<number>`COALESCE(SUM(${bonusTransactions.amount}), 0)::int` })
        .from(bonusTransactions)
        .where(
          and(
            eq(bonusTransactions.playerId, playerId),
            eq(bonusTransactions.type, 'earn_seed'),
            eq(bonusTransactions.referenceType, 'daily_presence'),
            gte(bonusTransactions.referenceId, fromDay),
            lte(bonusTransactions.referenceId, toDay),
          ),
        );

      return {
        window: { from: fromDay, to: toDay, days },
        total_seed_seconds: totalSeedSeconds,
        by_server: byServer,
        series,
        bonus: { k_seed: kSeed, earned_points: bonusRow?.earned ?? 0 },
      };
    },
  );
};

export default playerSeedContributionRoutes;
