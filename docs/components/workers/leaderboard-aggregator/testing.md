# worker-leaderboard-aggregator - Testing

## Running tests

```bash
pnpm --filter @squad/worker-leaderboard-aggregator build
pnpm --filter @squad/worker-leaderboard-aggregator exec vitest run
# one file
pnpm --filter @squad/worker-leaderboard-aggregator exec vitest run test/tick.test.ts
```

Vitest uses the shared worker config (`apps/workers/_test-shared/vitest.base.ts`: 40 s test timeout, `dist` excluded, and the `load-env.ts` setup file that fills `DATABASE_URL` and `REDIS_URL` from the repo `.env` when unset).

- `test/tick.test.ts` needs neither Postgres nor Redis: `@squad/db`, `ioredis`, `postgres`, `pino`, `@squad/diag` and `@squad/shared-config` are mocked.
- `test/contract.test.ts` spawns `dist/index.js`, so the package must be built first. It needs a reachable Redis (database 14 by default, `TEST_REDIS_DB`; URL from `TEST_REDIS_URL` or `REDIS_URL`) and a `DATABASE_URL` for the child process. See [local test setup](../../../development/local-test-setup.md).

## Test files

### `tick.test.ts` (15 tests)

| Group | What it verifies |
|---|---|
| `runLeaderboardAggregatorTick` (9 tests) | `alltime` rebuilt at most once per hour across three ticks (#1108); the derived periods are recomputed, the cache invalidated and `run_ok` emitted; no invalidation when no invalidator is supplied; the accrual count is folded into `run_ok`; an accrual failure emits `bonus_accruals_failed` and still `run_ok`, never `run_failed`; the active season is appended with its explicit range and named in `run_ok` (LEAD-7); no season gives `season: null`; a season lookup failure emits `season_window_failed` and still recomputes; a recompute failure emits `run_failed`. |
| `interval and backfill configuration` (4 tests) | `resolveTickIntervalMs` defaults and invalid input; `resolveBackfillMonths` defaults, valid and invalid input; the backfill runs only above 0 months and emits `backfill_ok`; a backfill error emits `backfill_failed` without throwing. |
| `invalidateLeaderboardCache` (2 tests) | Each scanned batch is unlinked as it arrives and every key is counted; nothing is unlinked when no key matches. |

### `contract.test.ts` (2 tests)

The shared `workerContract` from `apps/workers/_test-shared/contract.ts`.

| Test | What it verifies |
|---|---|
| publishes heartbeat within 30s of start | `worker:heartbeat:leaderboard-aggregator` appears with a TTL of at most 30 s. |
| exits 0 on repeated SIGTERM after publishing readiness | A second SIGTERM does not break the shutdown; exit code 0, no signal, within 8 s. |

## Coverage gaps

- The SQL in `recomputeLeaderboardPeriod`, `recomputeBonusAccruals` and `loadActiveSeasonTarget` is not exercised by this package: its tests mock `@squad/db`.
- `invalidateLeaderboardCache` is tested with a stub that exposes only `scanStream` and `unlink`, not against a real Redis.
- The `runWorker` wiring (backfill before the first tick, overlap guard, throttle state) is covered only indirectly by the contract test.
