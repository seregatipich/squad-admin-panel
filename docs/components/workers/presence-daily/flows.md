# worker-presence-daily - Flows

## Startup

1. `runWorker` connects Postgres (pool of one connection), then Redis when `REDIS_URL` is set. A missing `DATABASE_URL` logs `DATABASE_URL is required` and exits with code 1.
2. Starts the heartbeat (`worker:heartbeat:presence-daily`, every 5 s) and creates the diagnostic emitter.
3. Installs the SIGINT/SIGTERM handlers and emits `presence_daily.started`.
4. Runs `beforeFirstTick`: when `COPLAY_FULL_REBUILD` is exactly `1`, `runCoplayFullRebuild`.
5. Runs the tick once, then arms a 60-minute interval.

A startup tick that rejects aborts the worker with exit code 1 (the runner's default `firstRunFailure: 'fatal'`). Every step of the tick catches its own database errors, so in practice only a failing diagnostic emit can reach that path.

## Hourly tick

`runPresenceDailyTick` runs four independent steps in this order. A failure in one step is logged, reported through its own `*.run_failed` event, and the next step still runs.

1. **Presence.** `recentPresenceWindow(now)` gives yesterday..today (UTC). `recomputeDailyPresence` deletes that window from `player_daily_presence`, rebuilds it from `player_sessions` and refreshes `players.total_time_played_seconds`. Events: `presence_daily.run_ok` or `presence_daily.run_failed`.
2. **Server daily stats.** `recomputeServerDailyStats` over the same window. Events: `server_daily_stats.run_ok` or `server_daily_stats.run_failed`.
3. **Co-play.** `recentCoplayWindow(now)` (also yesterday..today) feeds `recomputeCoplayWindow`. Events: `coplay.run_ok` or `coplay.run_failed`.
4. **Economy accrual.** `runEconomyAccrual` iterates `daysInWindow(fromDay, toDay)` in ascending order (yesterday first). Each day is its own `try`: a failure is logged as `economy accrual failed`, emitted as `economy_accrual.run_failed` with the `day`, and the remaining days still run. `economy_accrual.run_ok` is emitted only when no day failed.

The rolling window is two days, so sessions from earlier days are never rewritten by the tick; a long-lived session that crosses midnight is split into both days' rows.

## Co-play full rebuild (administrative)

`runCoplayFullRebuild` calls `recomputeCoplayForAllSessions`: it finds the earliest session start and the latest end (or `now`) in `player_sessions` and recomputes `player_coplay` for every day in between in one transaction. It returns 0 when there are no sessions. On success it emits `coplay.full_rebuild_ok` with `rows`; on error it logs, emits `coplay.full_rebuild_failed` and the worker continues to its first tick. Run it as a one-shot container (see [configuration.md](./configuration.md)); the container still goes on to run the hourly loop until stopped.

## Overlap

The tick is configured with `overlap: 'allow'`: if a tick runs longer than 60 minutes, the next interval starts a second tick concurrently rather than being skipped. The pool holds one connection, so the overlapping tick's queries wait for the first one's; accrual additionally takes a per-day advisory lock, so two accrual runs for the same day cannot double-accrue.

## Graceful shutdown (SIGTERM / SIGINT)

1. Clears the tick interval.
2. Emits `presence_daily.stopped` with `sig`.
3. Stops the heartbeat.
4. `sql.end({ timeout: 5 })` (seconds).
5. `redis.quit()`.
6. Exits through the shared shutdown controller. A signal received before the startup passes finish is remembered; the shutdown runs once the first tick returns and the interval is never armed.
