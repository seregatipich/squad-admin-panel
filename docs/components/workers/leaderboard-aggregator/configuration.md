# worker-leaderboard-aggregator - Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string; a missing value is fatal (`DATABASE_URL is required`, exit code 1). Parsed by `runWorker`. | yes |
| `REDIS_URL` | no in code, set in compose | none | Redis connection. Without it the worker runs with no heartbeat, a no-op diagnostic emitter and no cache invalidation. | yes |
| `LEADERBOARD_AGGREGATOR_INTERVAL_MS` | no | `900000` | Tick interval in milliseconds. Parsed by `resolveTickIntervalMs`; non-numeric, zero or negative values fall back to 900000. | no |
| `LEADERBOARD_BACKFILL_MONTHS` | no | `0` | Number of calendar months of `month` periods to recompute once at startup, current month included. Parsed by `resolveBackfillMonths`; fractional values are floored, non-numeric or non-positive values disable the backfill. | no |
| `LOG_LEVEL` | no | `info` | Pino log level, read by `createWorkerLog`. | no |

Compose passes `DATABASE_URL`, `REDIS_URL`, `LEADERBOARD_AGGREGATOR_INTERVAL_MS` (default `900000`) and `LEADERBOARD_BACKFILL_MONTHS` (default `0`) to `worker-leaderboard-aggregator`. It does not pass `LOG_LEVEL`, so the container logs at `info` unless the service environment is extended. The two worker-specific variables are listed in `.env.example` and in [environment variables](../../../operations/environment-variables.md).

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| `alltime` rebuild throttle | 3 600 000 ms | `ALLTIME_RECOMPUTE_INTERVAL_MS` in `src/index.ts` |
| Cache key prefix | `leaderboard:` | `LEADERBOARD_CACHE_PREFIX` in `src/index.ts` |
| Cache `SCAN` batch size | 200 | `invalidateLeaderboardCache` |
| Postgres pool size | 1 | `postgres: { options: { max: 1 } }` in `runWorker` |
| Bonus accrual window | 30 days | `recomputeBonusAccruals` |
| Heartbeat interval / TTL | 5 s / 30 s | `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TTL_SECONDS` in `@squad/shared-config` |
| Postgres shutdown wait | 5 s | `POSTGRES_END_TIMEOUT_SECONDS` in `@squad/worker-kit` |

## Compose requirements

- No `user:` override and no bridge socket: the worker never calls the host bridge.
- Shared `hardening` block (all capabilities dropped, read-only root, `/tmp` tmpfs) and `worker-limits` (512 MB, 1 CPU).
- `depends_on`: `postgres` healthy, `migrator` completed successfully.

## Redis retry strategy

`runWorker` creates the client with `maxRetriesPerRequest: null` and retries with `delay = min(2000, 200 * 2^min(attempt, 6))` ms.
