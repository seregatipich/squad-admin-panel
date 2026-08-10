import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  backfillMonths,
  loadActiveSeasonTarget,
  periodsToRecompute,
  type RecomputePeriodInput,
  recomputeBonusAccruals,
  recomputeLeaderboardPeriods,
} from '@squad/db';
import { createDiag, type Diag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-leaderboard-aggregator' },
});

const COMPONENT = 'worker-leaderboard-aggregator';
const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const LEADERBOARD_CACHE_PREFIX = 'leaderboard:';

/**
 * Tick interval in milliseconds, from `LEADERBOARD_AGGREGATOR_INTERVAL_MS`.
 * Falls back to 15 minutes when unset, non-numeric, or not positive.
 */
export function resolveTickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.LEADERBOARD_AGGREGATOR_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_INTERVAL_MS;
}

/**
 * Startup backfill depth in months, from `LEADERBOARD_BACKFILL_MONTHS`
 * (DOSSIER-4 #191 one-shot combat backfill). Defaults to 0 (disabled);
 * non-numeric or negative values also disable it.
 */
export function resolveBackfillMonths(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.LEADERBOARD_BACKFILL_MONTHS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export async function invalidateLeaderboardCache(redis: Redis): Promise<number> {
  const keys: string[] = [];
  const stream = redis.scanStream({ match: `${LEADERBOARD_CACHE_PREFIX}*`, count: 200 });
  for await (const batch of stream) {
    for (const key of batch as string[]) keys.push(key);
  }
  if (keys.length === 0) return 0;
  await redis.del(...keys);
  return keys.length;
}

export interface LeaderboardTickDeps {
  sql: postgres.Sql;
  diag: Diag;
  invalidateCache?: () => Promise<number>;
  now?: Date;
}

export async function runLeaderboardAggregatorTick(deps: LeaderboardTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const periods: RecomputePeriodInput[] = periodsToRecompute(now);

  // LEAD-7 (#178): the tick's third responsibility — materialise the running
  // season. `periodsToRecompute` is pure and cannot emit a season descriptor,
  // because a season's window lives in the database rather than in the clock.
  // A season that is closed or finalized is not returned, so its rows stop
  // changing the moment it is frozen. A lookup failure must not cost us the
  // ordinary day/week/month recompute, so it is guarded on its own.
  let seasonName: string | null = null;
  try {
    const season = await loadActiveSeasonTarget(sql);
    if (season) {
      seasonName = season.name;
      periods.push({
        periodType: season.periodType,
        periodStart: season.periodStart,
        range: season.range,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'active season lookup failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'leaderboard_aggregator.season_window_failed',
      severity: 'error',
      message: `active season lookup failed: ${message}`,
      payload: {},
    });
  }

  try {
    const rows = await recomputeLeaderboardPeriods(sql, periods);

    // ECON-5 (#165): the tick's second responsibility — rebuild the rolling
    // 30-day bonus accrual window. Its failure must not kill the tick, so it
    // is guarded separately and reported via its own diag kind.
    let bonusAccrualRows = 0;
    try {
      bonusAccrualRows = await recomputeBonusAccruals(sql, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'bonus accrual window recompute failed');
      await diag.emit({
        component: COMPONENT,
        kind: 'leaderboard_aggregator.bonus_accruals_failed',
        severity: 'error',
        message: `bonus accrual window recompute failed: ${message}`,
        payload: {},
      });
    }

    const invalidated = deps.invalidateCache ? await deps.invalidateCache() : 0;
    log.info(
      { periods: periods.length, rows, bonusAccrualRows, invalidated, season: seasonName },
      'leaderboard recompute ok',
    );
    await diag.emit({
      component: COMPONENT,
      kind: 'leaderboard_aggregator.run_ok',
      severity: 'info',
      message: `recomputed ${periods.length} periods (${rows} rows)`,
      payload: { periods: periods.length, rows, bonusAccrualRows, invalidated, season: seasonName },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'leaderboard recompute failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'leaderboard_aggregator.run_failed',
      severity: 'error',
      message: `recompute failed: ${message}`,
      payload: { periods: periods.length },
    });
  }
}

export interface StartupBackfillDeps {
  sql: postgres.Sql;
  diag: Diag;
}

/**
 * One-shot startup backfill: recomputes the last `months` month periods so
 * historical combat data lands in `player_stat_periods` without waiting for
 * the regular ticks. No-op when `months <= 0`; failures are reported via diag
 * and never crash the worker.
 *
 * @returns number of rows written (0 when disabled or failed).
 */
export async function runStartupBackfill(
  deps: StartupBackfillDeps,
  months: number,
): Promise<number> {
  if (months <= 0) return 0;
  try {
    const rows = await backfillMonths(deps.sql, months);
    log.info({ months, rows }, 'leaderboard backfill ok');
    await deps.diag.emit({
      component: COMPONENT,
      kind: 'leaderboard_aggregator.backfill_ok',
      severity: 'info',
      message: `backfilled ${months} months (${rows} rows)`,
      payload: { months, rows },
    });
    return rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'leaderboard backfill failed');
    await deps.diag.emit({
      component: COMPONENT,
      kind: 'leaderboard_aggregator.backfill_failed',
      severity: 'error',
      message: `backfill failed: ${message}`,
      payload: { months },
    });
    return 0;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'leaderboard-aggregator',
        statusFn: () => 'idle',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };
  const invalidateCache = redis ? () => invalidateLeaderboardCache(redis) : undefined;

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      if (interval) clearInterval(interval);
      await diag.emit({
        component: COMPONENT,
        kind: 'leaderboard_aggregator.stopped',
        severity: 'info',
        message: `leaderboard-aggregator received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      await sql.end({ timeout: 5 });
      await redis?.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: COMPONENT,
    kind: 'leaderboard_aggregator.started',
    severity: 'info',
    message: 'leaderboard-aggregator started',
    payload: { pid: process.pid },
  });

  await runStartupBackfill({ sql, diag }, resolveBackfillMonths());

  await runLeaderboardAggregatorTick({ sql, diag, invalidateCache });
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  interval = setInterval(() => {
    runLeaderboardAggregatorTick({ sql, diag, invalidateCache }).catch((err) =>
      log.error({ err: (err as Error).message }, 'leaderboard tick failed'),
    );
  }, resolveTickIntervalMs());
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((err) => {
    log.fatal({ err: (err as Error).message }, 'fatal');
    process.exit(1);
  });
}
