# worker-presence-daily - Testing

## Running tests

```bash
pnpm --filter @squad/worker-presence-daily build
pnpm --filter @squad/worker-presence-daily exec vitest run
# one file
pnpm --filter @squad/worker-presence-daily exec vitest run test/tick.test.ts
```

Vitest uses the shared worker config (`apps/workers/_test-shared/vitest.base.ts`: 40 s test timeout, `dist` excluded, and the `load-env.ts` setup file that fills `DATABASE_URL` and `REDIS_URL` from the repo `.env` when unset).

- `test/tick.test.ts` needs neither Postgres nor Redis: `@squad/db`, `ioredis`, `postgres`, `pino`, `@squad/diag` and `@squad/shared-config` are mocked.
- `test/contract.test.ts` spawns `dist/index.js`, so the package must be built first. It needs a reachable Redis (database 14 by default, `TEST_REDIS_DB`; URL from `TEST_REDIS_URL` or `REDIS_URL`) and a `DATABASE_URL` for the child process. See [local test setup](../../../development/local-test-setup.md).

## Test files

### `tick.test.ts` (11 tests)

| Group | What it verifies |
|---|---|
| `runPresenceDailyTick` (9 tests) | The recent window is recomputed and `presence_daily.run_ok` emitted; the co-play window is recomputed with `coplay.run_ok`; `server_daily_stats` is rolled up over the same window with `server_daily_stats.run_ok`; a rollup failure emits `server_daily_stats.run_failed` and economy accrual still runs; a presence failure emits `presence_daily.run_failed`; a co-play failure emits `coplay.run_failed`; accrual runs for every day of the window (`2026-07-04` and `2026-07-05`) and emits `economy_accrual.run_ok`; an accrual failure emits `economy_accrual.run_failed`; when yesterday fails, today is still accrued, the failed day is reported and `economy_accrual.run_ok` is not emitted (#18). |
| `runCoplayFullRebuild` (2 tests) | The rebuild function is called and `coplay.full_rebuild_ok` carries the row count; a failure emits `coplay.full_rebuild_failed` without throwing. |

### `contract.test.ts` (2 tests)

The shared `workerContract` from `apps/workers/_test-shared/contract.ts`.

| Test | What it verifies |
|---|---|
| publishes heartbeat within 30s of start | `worker:heartbeat:presence-daily` appears with a TTL of at most 30 s. |
| exits 0 on repeated SIGTERM after publishing readiness | A second SIGTERM does not break the shutdown; exit code 0, no signal, within 8 s. |

## Coverage gaps

- The SQL of `recomputeDailyPresence`, `recomputeServerDailyStats`, `recomputeCoplayWindow` and `accrueDailyBonuses` is not exercised by this package: its tests mock `@squad/db`.
- The `COPLAY_FULL_REBUILD` branch of `beforeFirstTick`, the one-hour interval and the `overlap: 'allow'` policy are not asserted by any test.
