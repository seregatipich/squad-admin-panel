# worker-leaderboard-aggregator

## Purpose

Rebuilds the materialised leaderboard aggregates every 15 minutes (by default): the `player_stat_periods` rows for the current and previous day, week and month, the throttled `alltime` period and the running named season, plus the rolling 30-day `player_bonus_accruals` window. After each pass it drops the API's `leaderboard:*` response cache so readers see the new numbers.

## Responsibilities

- Run one tick at startup and then every `LEADERBOARD_AGGREGATOR_INTERVAL_MS` (default 900000 ms).
- Recompute the periods returned by `periodsToRecompute(now)` (day, week and month for the current and previous period, plus `alltime`) through `recomputeLeaderboardPeriods`.
- Rebuild `alltime` at most once per hour per process (it scans the whole history); the other periods are rebuilt on every tick.
- Look up the one active, non-finalized season with `loadActiveSeasonTarget` and recompute it over its explicit UTC day window.
- Rebuild `player_bonus_accruals` with `recomputeBonusAccruals` (ECON-5).
- Delete every Redis key matching `leaderboard:*` when Redis is configured.
- Optionally run a one-shot startup backfill of the last `LEADERBOARD_BACKFILL_MONTHS` month periods before the first tick.
- Publish `worker:heartbeat:leaderboard-aggregator` (status `idle`) and `leaderboard_aggregator.*` diagnostic events.

## What it does not do

- Does not serve leaderboards; `GET /api/v1/leaderboards` and `GET /api/v1/leaderboards/bonuses` in the API read the tables this worker writes.
- Does not create, activate, close or finalize seasons. This worker only reads `seasons` and skips a season once it is no longer `active` or is `finalized`.
- Does not write `player_daily_presence`; that is `worker-presence-daily`. A stale presence table yields stale online, boost and seeding columns here.
- Does not talk to the host bridge.

## Code location

```
apps/workers/leaderboard-aggregator/
  src/
    index.ts            - tick, startup backfill, cache invalidation, runWorker wiring
  test/
    tick.test.ts        - unit tests with @squad/db mocked
    contract.test.ts    - shared worker contract (heartbeat, SIGTERM) against dist/index.js
```

The worker source is [`apps/workers/leaderboard-aggregator/src/index.ts`](../../../../apps/workers/leaderboard-aggregator/src/index.ts). The SQL lives in `packages/db`: [`leaderboard/aggregate.ts`](../../../../packages/db/src/leaderboard/aggregate.ts), [`leaderboard/season.ts`](../../../../packages/db/src/leaderboard/season.ts) and [`economy/accruals-aggregate.ts`](../../../../packages/db/src/economy/accruals-aggregate.ts).

## Dependencies

- `@squad/db` - `periodsToRecompute`, `recomputeLeaderboardPeriods`, `loadActiveSeasonTarget`, `recomputeBonusAccruals`, `backfillMonths`
- `@squad/worker-kit` - `createWorkerLog`, `runWorker` (lifecycle, heartbeat, shutdown, tick loop)
- `@squad/diag` - diagnostic events (through `runWorker`)
- `@squad/shared-config` - heartbeat contract (through `runWorker`)
- `postgres` - pool of one connection (`max: 1`)
- `ioredis` - optional; used for the heartbeat, diagnostics and cache invalidation

## Runtime shape

- Compose service `worker-leaderboard-aggregator` in `docker/compose.yml`, built from `docker/worker.Dockerfile` with `WORKER=leaderboard-aggregator`. It uses the shared `hardening` and `worker-limits` blocks (read-only root filesystem, 512 MB, 1 CPU) and has no `user:` override, no published port and no bridge socket.
- Starts after `postgres` is healthy and `migrator` has completed.
- Redis is optional in code (`redis: { optional: true }`), but compose always provides `REDIS_URL`.

## Components that depend on it

- API leaderboard routes read `player_stat_periods`, and `GET /api/v1/leaderboards/bonuses?period=30d` reads `player_bonus_accruals`. Cached leaderboard responses live under `leaderboard:*` with a 60 s TTL and are cleared by this worker.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
