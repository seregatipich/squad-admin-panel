# worker-presence-daily - Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string; a missing value is fatal (`DATABASE_URL is required`, exit code 1). Parsed by `runWorker`. | yes |
| `REDIS_URL` | no in code, set in compose | none | Redis connection. Without it the worker runs with no heartbeat and a no-op diagnostic emitter. | yes |
| `COPLAY_FULL_REBUILD` | no | unset | When exactly `1`, runs the full co-play rebuild once before the first tick. Read in `beforeFirstTick` in `src/index.ts`. Any other value does nothing. | no |
| `LOG_LEVEL` | no | `info` | Pino log level, read by `createWorkerLog`. | no |

Compose passes only `DATABASE_URL` and `REDIS_URL` to `worker-presence-daily`; it does not forward `COPLAY_FULL_REBUILD` or `LOG_LEVEL`. Use a one-shot container for the rebuild, as `.env.example` describes:

```bash
docker compose run --rm -e COPLAY_FULL_REBUILD=1 worker-presence-daily
```

Do not set the variable on the long-running service: it would repeat the rebuild on every start. The variable is listed in `.env.example` and in [environment variables](../../../operations/environment-variables.md).

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Tick interval | 3 600 000 ms (1 h) | `TICK_INTERVAL_MS` in `src/index.ts`; not configurable |
| Tick overlap policy | `'allow'` | tick definition in `runWorker`; ticks may overlap |
| Recompute window | yesterday and today (UTC) | `recentPresenceWindow`, `recentCoplayWindow` in `@squad/db` |
| Session lookback for partition pruning | 2 days | `SESSION_PRUNE_LOOKBACK_SECONDS` in `packages/db/src/session-window.ts` |
| Postgres pool size | 1 | `postgres: { options: { max: 1 } }` in `runWorker` |
| Heartbeat interval / TTL | 5 s / 30 s | `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TTL_SECONDS` in `@squad/shared-config` |
| Postgres shutdown wait | 5 s | `POSTGRES_END_TIMEOUT_SECONDS` in `@squad/worker-kit` |

Accrual coefficients and the economy switch are not environment settings; they come from the `economy_settings` row (`k_online`, `k_boost`, `k_seed`, `seed_threshold`, `economy_enabled`).

## Compose requirements

- No `user:` override and no bridge socket: the worker never calls the host bridge.
- Shared `hardening` block (all capabilities dropped, read-only root, `/tmp` tmpfs) and `worker-limits` (512 MB, 1 CPU).
- `depends_on`: `postgres` healthy, `migrator` completed successfully.

## Redis retry strategy

`runWorker` creates the client with `maxRetriesPerRequest: null` and retries with `delay = min(2000, 200 * 2^min(attempt, 6))` ms.
