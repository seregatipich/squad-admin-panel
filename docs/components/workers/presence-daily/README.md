# worker-presence-daily

## Purpose

Every hour, rebuilds the daily rollups derived from `player_sessions` for the two most recent UTC days (yesterday and today): `player_daily_presence`, `server_daily_stats` and `player_coplay`. It then accrues economy bonuses for the same two days. On request, a startup flag rebuilds the whole co-play graph once.

## Responsibilities

- Run one tick at startup and then every 60 minutes (fixed interval, not configurable).
- `recomputeDailyPresence` over yesterday..today: rewrites `player_daily_presence` and refreshes `players.total_time_played_seconds` for the players with sessions touching the window.
- `recomputeServerDailyStats` over the same window: rewrites `server_daily_stats`, the only writer of that table.
- `recomputeCoplayWindow` over yesterday..today: rewrites the `player_coplay` daily buckets.
- `runEconomyAccrual`: for each day in the window, `accrueDailyBonuses` re-attributes `seed_seconds` in `player_daily_presence` and, when the economy is enabled, rewrites that day's `earn_online`, `earn_boost` and `earn_seed` rows in `bonus_transactions` and adjusts `players.bonus_balance`.
- When `COPLAY_FULL_REBUILD=1` is set, run `recomputeCoplayForAllSessions` once before the first tick.
- Publish `worker:heartbeat:presence-daily` (status `idle`) and diagnostic events.

## What it does not do

- Does not record sessions; `worker-rcon` writes `player_sessions`.
- Does not rebuild `player_stat_periods` or `player_bonus_accruals`; `worker-leaderboard-aggregator` does, from the tables written here.
- Does not backfill `player_daily_presence` for history older than yesterday (`recomputeDailyPresenceForAllSessions` exists in `@squad/db` but this worker never calls it).
- Does not talk to the host bridge.

## Code location

```
apps/workers/presence-daily/
  src/
    index.ts            - tick, economy accrual, co-play full rebuild, runWorker wiring
  test/
    tick.test.ts        - unit tests with @squad/db mocked
    contract.test.ts    - shared worker contract (heartbeat, SIGTERM) against dist/index.js
```

The worker source is [`apps/workers/presence-daily/src/index.ts`](../../../../apps/workers/presence-daily/src/index.ts). The SQL lives in `packages/db`: [`presence/daily.ts`](../../../../packages/db/src/presence/daily.ts), [`statistics/daily.ts`](../../../../packages/db/src/statistics/daily.ts), [`coplay/aggregate.ts`](../../../../packages/db/src/coplay/aggregate.ts) and [`economy/accrual.ts`](../../../../packages/db/src/economy/accrual.ts).

## Dependencies

- `@squad/db` - `recentPresenceWindow`, `recomputeDailyPresence`, `recomputeServerDailyStats`, `recentCoplayWindow`, `recomputeCoplayWindow`, `recomputeCoplayForAllSessions`, `daysInWindow`, `accrueDailyBonuses`
- `@squad/worker-kit` - `createWorkerLog`, `runWorker` (lifecycle, heartbeat, shutdown, tick loop)
- `@squad/diag` - diagnostic events (through `runWorker`)
- `@squad/shared-config` - heartbeat contract (through `runWorker`)
- `postgres` - pool of one connection (`max: 1`)
- `ioredis` - optional; used for the heartbeat and diagnostics

## Runtime shape

- Compose service `worker-presence-daily` in `docker/compose.yml`, built from `docker/worker.Dockerfile` with `WORKER=presence-daily`. It uses the shared `hardening` and `worker-limits` blocks (read-only root filesystem, 512 MB, 1 CPU) and has no `user:` override, no published port and no bridge socket.
- Starts after `postgres` is healthy and `migrator` has completed.
- Redis is optional in code (`redis: { optional: true }`), but compose always provides `REDIS_URL`.

## Components that depend on it

- `worker-leaderboard-aggregator` reads `player_daily_presence` and `bonus_transactions`.
- `worker-seed-reward` reads `player_daily_presence.seed_seconds`, which this worker re-attributes during accrual.
- The API statistics endpoint reads `server_daily_stats`; the co-play views read `player_coplay`.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
