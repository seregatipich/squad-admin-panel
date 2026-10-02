# worker-leaderboard-aggregator - API surface

No HTTP surface and no bridge RPC. The worker opens no port.

## Exported functions

All exports of [`src/index.ts`](../../../../apps/workers/leaderboard-aggregator/src/index.ts). The worker only starts when the module is the entry script, so tests can import them freely.

| Export | Purpose |
|---|---|
| `LEADERBOARD_CACHE_PREFIX` | The constant `'leaderboard:'`. |
| `resolveTickIntervalMs(env?)` | Reads `LEADERBOARD_AGGREGATOR_INTERVAL_MS`; falls back to 900000 ms when unset, non-numeric or not positive. |
| `resolveBackfillMonths(env?)` | Reads `LEADERBOARD_BACKFILL_MONTHS`; floors positive values, returns 0 for unset, non-numeric or non-positive input. |
| `invalidateLeaderboardCache(redis)` | `SCAN` with `MATCH leaderboard:*` and `COUNT 200`, `UNLINK` each batch, returns the number of keys removed. |
| `runLeaderboardAggregatorTick(deps)` | One recompute pass; takes `sql`, `diag`, optional `invalidateCache`, optional `now` and optional `alltimeState`. |
| `runStartupBackfill(deps, months)` | One-shot month backfill; returns rows written, 0 when `months <= 0` or on failure. |
| `AlltimeRecomputeState` | `{ lastRecomputedAtMs: number \| null }`, the hourly throttle state for `alltime`. |

## Redis

| Key | Access | Description |
|---|---|---|
| `worker:heartbeat:leaderboard-aggregator` | write | Liveness heartbeat, published every 5 s with TTL 30 s, status text `idle`. |
| `leaderboard:*` | `SCAN` + `UNLINK` | API response cache. Written by the API (`CACHE_PREFIX` in `apps/api/src/routes/leaderboards.ts`, TTL 60 s); this worker only deletes keys after a successful period recompute. |
| `diag:queue` | stream append via `@squad/diag` | Diagnostic events. |

The worker consumes no streams and joins no consumer groups.

## Diagnostic events (`diag:queue` Redis Stream)

All kinds carry `component: 'worker-leaderboard-aggregator'`.

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `leaderboard_aggregator.started` | `info` | After startup, before the backfill and the first tick (emitted by `runWorker`). | `pid` |
| `leaderboard_aggregator.stopped` | `info` | In the SIGTERM/SIGINT handler. | `sig` |
| `leaderboard_aggregator.run_ok` | `info` | The period recompute completed. Emitted even when the bonus accrual recompute failed. | `periods`, `rows`, `bonusAccrualRows`, `invalidated`, `season` (name or `null`) |
| `leaderboard_aggregator.run_failed` | `error` | `recomputeLeaderboardPeriods` threw. The accrual rebuild and cache invalidation are skipped. | `periods` |
| `leaderboard_aggregator.bonus_accruals_failed` | `error` | `recomputeBonusAccruals` threw; the tick continues and still emits `run_ok`. | none |
| `leaderboard_aggregator.season_window_failed` | `error` | `loadActiveSeasonTarget` threw; the tick continues without the season. | none |
| `leaderboard_aggregator.backfill_ok` | `info` | The startup backfill finished. | `months`, `rows` |
| `leaderboard_aggregator.backfill_failed` | `error` | The startup backfill threw; the worker keeps running. | `months` |

The `periods` payload counts the descriptors handed to the recompute (including the season when one is active), not the distinct periods that changed.

## Logs

Pino JSON logs tagged `service: "worker-leaderboard-aggregator"`: `leaderboard recompute ok`, `leaderboard recompute failed`, `bonus accrual window recompute failed`, `active season lookup failed`, `leaderboard backfill ok`, `leaderboard backfill failed`, and the overlap warning `previous leaderboard tick still running, skipping this interval`.
