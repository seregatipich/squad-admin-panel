import {
  backfillMonths,
  loadActiveSeasonTarget,
  periodsToRecompute,
  type RecomputePeriodInput,
  recomputeBonusAccruals,
  recomputeLeaderboardPeriods,
} from '@squad/db';
import type { Diag } from '@squad/diag';
import { createWorkerLog, runWorker } from '@squad/worker-kit';
import type Redis from 'ioredis';
import type postgres from 'postgres';

const log = createWorkerLog('leaderboard-aggregator');

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
  let removed = 0;
  const stream = redis.scanStream({ match: `${LEADERBOARD_CACHE_PREFIX}*`, count: 200 });
  for await (const batch of stream as AsyncIterable<string[]>) {
    if (batch.length === 0) continue;
    await redis.unlink(...batch);
    removed += batch.length;
  }
  return removed;
}

const ALLTIME_RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000;

/** When the unbounded `alltime` period was last rebuilt successfully. */
export interface AlltimeRecomputeState {
  lastRecomputedAtMs: number | null;
}

export interface LeaderboardTickDeps {
  sql: postgres.Sql;
  diag: Diag;
  invalidateCache?: () => Promise<number>;
  now?: Date;
  /**
   * Throttles the `alltime` period to one rebuild per hour (#1108): it scans
   * the whole history of `player_daily_presence` and `match_players` and
   * rewrites every row, which is wasteful every 15 minutes. Without it the
   * period is rebuilt on every tick.
   */
  alltimeState?: AlltimeRecomputeState;
}

const processAlltimeState: AlltimeRecomputeState = { lastRecomputedAtMs: null };

export async function runLeaderboardAggregatorTick(deps: LeaderboardTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const { alltimeState } = deps;
  const alltimeDue =
    !alltimeState ||
    alltimeState.lastRecomputedAtMs === null ||
    now.getTime() - alltimeState.lastRecomputedAtMs >= ALLTIME_RECOMPUTE_INTERVAL_MS;
  const periods: RecomputePeriodInput[] = periodsToRecompute(now).filter(
    (period) => alltimeDue || period.periodType !== 'alltime',
  );

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
    if (alltimeState && periods.some((period) => period.periodType === 'alltime')) {
      alltimeState.lastRecomputedAtMs = now.getTime();
    }

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

runWorker({
  name: 'leaderboard-aggregator',
  log,
  entrypoint: import.meta.url,
  postgres: { options: { max: 1 } },
  redis: { optional: true },
  heartbeatStatus: 'idle',
  setup: ({ sql, redis, diag }) => {
    const invalidateCache = redis ? () => invalidateLeaderboardCache(redis) : undefined;
    return {
      beforeFirstTick: async () => {
        await runStartupBackfill({ sql, diag }, resolveBackfillMonths());
      },
      ticks: [
        {
          intervalMs: resolveTickIntervalMs(),
          // A tick can outlast the interval on a large database; skipping the overlap
          // stops recomputes from queueing on the single pooled connection.
          overlap: { warn: 'previous leaderboard tick still running, skipping this interval' },
          failureMessage: 'leaderboard tick failed',
          run: () =>
            runLeaderboardAggregatorTick({
              sql,
              diag,
              invalidateCache,
              alltimeState: processAlltimeState,
            }),
        },
      ],
    };
  },
});
