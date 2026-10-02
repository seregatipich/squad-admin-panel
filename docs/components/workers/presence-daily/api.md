# worker-presence-daily - API surface

No HTTP surface and no bridge RPC. The worker opens no port.

## Exported functions

All exports of [`src/index.ts`](../../../../apps/workers/presence-daily/src/index.ts). The worker only starts when the module is the entry script, so tests can import them freely.

| Export | Purpose |
|---|---|
| `PresenceTickDeps` | `{ sql, diag, now? }`, the dependencies of every function below. |
| `runPresenceDailyTick(deps)` | One hourly pass: presence, server daily stats, co-play, then economy accrual. |
| `runEconomyAccrual(deps)` | Accrues bonuses for every day in the recent presence window, each day in its own `try`. |
| `runCoplayFullRebuild(deps)` | Full co-play rebuild over every day with session data; failures are reported, never thrown. |

## Redis

| Key | Access | Description |
|---|---|---|
| `worker:heartbeat:presence-daily` | write | Liveness heartbeat, published every 5 s with TTL 30 s, status text `idle`. |
| `diag:queue` | stream append via `@squad/diag` | Diagnostic events. |

The worker reads no Redis keys, consumes no streams and joins no consumer groups.

## Diagnostic events (`diag:queue` Redis Stream)

All kinds carry `component: 'worker-presence-daily'`. Window fields are `fromDay` and `toDay` (UTC `YYYY-MM-DD`).

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `presence_daily.started` | `info` | After startup, before the first tick (emitted by `runWorker`). | `pid` |
| `presence_daily.stopped` | `info` | In the SIGTERM/SIGINT handler. | `sig` |
| `presence_daily.run_ok` | `info` | `recomputeDailyPresence` succeeded. | `fromDay`, `toDay`, `rows` |
| `presence_daily.run_failed` | `error` | `recomputeDailyPresence` threw. | `fromDay`, `toDay` |
| `server_daily_stats.run_ok` | `info` | `recomputeServerDailyStats` succeeded. | `fromDay`, `toDay`, `rows` |
| `server_daily_stats.run_failed` | `error` | `recomputeServerDailyStats` threw. | `fromDay`, `toDay` |
| `coplay.run_ok` | `info` | `recomputeCoplayWindow` succeeded. | `fromDay`, `toDay`, `rows` |
| `coplay.run_failed` | `error` | `recomputeCoplayWindow` threw. | `fromDay`, `toDay` |
| `economy_accrual.run_ok` | `info` | Every day in the window accrued without error. | `fromDay`, `toDay`, `economyEnabled`, `players`, `transactions`, `balanceDelta`, `shortfallForgiven` |
| `economy_accrual.run_failed` | `error` | `accrueDailyBonuses` threw for one day; one event per failed day. | `fromDay`, `toDay`, `day` |
| `coplay.full_rebuild_ok` | `info` | `COPLAY_FULL_REBUILD=1` rebuild finished. | `rows` |
| `coplay.full_rebuild_failed` | `error` | The full rebuild threw. | none |

Each step catches its own error, so one failing step does not stop the following ones. Per-day accrual sums (`players`, `transactions`, `balanceDelta`, `shortfallForgiven`) are totals across the window and `economyEnabled` is true when any day saw the economy enabled. `economy_accrual.run_ok` is skipped when at least one day failed.

## Logs

Pino JSON logs tagged `service: "worker-presence-daily"`: `presence daily recompute ok` / `failed`, `server daily stats rollup ok` / `failed`, `coplay recompute ok` / `failed`, `economy accrual ok` / `failed`, `coplay full rebuild ok` / `failed`, `presence tick failed` (an unexpected rejection of a tick).
