# worker-leaderboard-aggregator - Flows

## Startup

1. `runWorker` connects Postgres (pool of one connection), then Redis when `REDIS_URL` is set. A missing `DATABASE_URL` logs `DATABASE_URL is required` and exits with code 1.
2. Starts the heartbeat (`worker:heartbeat:leaderboard-aggregator`, every 5 s) and creates the diagnostic emitter.
3. Installs the SIGINT/SIGTERM handlers and emits `leaderboard_aggregator.started`.
4. Runs `beforeFirstTick`: `runStartupBackfill` with `LEADERBOARD_BACKFILL_MONTHS`; a no-op when it is 0.
5. Runs the tick once, then arms an interval of `LEADERBOARD_AGGREGATOR_INTERVAL_MS`.

A startup tick that rejects aborts the worker with exit code 1 (the runner's default `firstRunFailure: 'fatal'`). The tick catches its own database errors, so in practice only a failing diagnostic emit can reach that path.

## Tick

`runLeaderboardAggregatorTick`:

1. `periodsToRecompute(now)`; drop `alltime` unless it is due (never rebuilt in this process, or last rebuilt at least one hour ago).
2. `loadActiveSeasonTarget`; when a season is active, append it with its explicit range and remember its name. On failure log `active season lookup failed`, emit `leaderboard_aggregator.season_window_failed` and continue without the season.
3. `recomputeLeaderboardPeriods` runs the periods one after another, each in its own transaction. On success, when `alltime` was in the list, the throttle timestamp is set to `now`.
4. `recomputeBonusAccruals(sql, now)`. A failure is logged, reported as `leaderboard_aggregator.bonus_accruals_failed`, and the tick goes on with `bonusAccrualRows = 0`.
5. `invalidateLeaderboardCache` when Redis is configured; otherwise `invalidated` is 0.
6. Log `leaderboard recompute ok` and emit `leaderboard_aggregator.run_ok` with `periods`, `rows`, `bonusAccrualRows`, `invalidated` and `season`.

If step 3 throws, the tick logs `leaderboard recompute failed`, emits `leaderboard_aggregator.run_failed` with `periods`, and skips steps 4 to 6 (no accrual rebuild, no cache invalidation, no throttle update). Periods already committed before the failure stay committed. The next interval retries.

## Overlap

The tick uses `overlap: { warn: ... }`: when an interval fires while the previous tick still runs, the new call is skipped and `previous leaderboard tick still running, skipping this interval` is logged at `warn`. This keeps recomputes from queueing on the single pooled connection.

## Startup backfill

`runStartupBackfill(deps, months)` returns 0 immediately when `months <= 0`. Otherwise it calls `backfillMonths`, logs `leaderboard backfill ok` and emits `leaderboard_aggregator.backfill_ok` with `months` and `rows`. On error it logs, emits `leaderboard_aggregator.backfill_failed` and returns 0; the worker continues to its first tick. The backfill runs on every start while the variable stays above 0, so reset it after the one-off run.

## Graceful shutdown (SIGTERM / SIGINT)

1. Clears the tick interval.
2. Emits `leaderboard_aggregator.stopped` with `sig`.
3. Stops the heartbeat.
4. `sql.end({ timeout: 5 })` (seconds).
5. `redis.quit()`.
6. Exits through the shared shutdown controller. A signal received before the startup passes finish is remembered; the shutdown runs once the first tick returns and the intervals are never armed.
