# worker-clan-priority-expirer - Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | - | PostgreSQL connection string. A missing value is logged as `DATABASE_URL is required` (fatal) and the process exits with code 1. | yes |
| `REDIS_URL` | yes | - | Redis connection string, used for the heartbeat and `diag:queue`. A missing value is fatal in the same way. | yes |
| `CLAN_PRIORITY_EXPIRER_INTERVAL_MS` | no | `60000` | Tick interval in milliseconds, parsed by `positiveIntEnv` in `src/index.ts`. A blank value falls back to the default; a value that is not a positive integer throws when the module loads, so the worker fails at startup instead of ticking every millisecond. | no |
| `LOG_LEVEL` | no | `info` | Pino log level, read by `createWorkerLog`. Neither compose file passes it to this service, so it is `info` unless added to the service's `environment`. | no |

`docker/compose.yml` and `docker/compose.stand.yml` pass `DATABASE_URL`, `REDIS_URL` and `CLAN_PRIORITY_EXPIRER_INTERVAL_MS` (default `60000`). The stand file also sets `WORKER: clan-priority-expirer` for the shared workers image; `docker/compose.yml` builds `docker/worker.Dockerfile` with `WORKER: clan-priority-expirer`.

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Heartbeat interval | 5 000 ms | `HEARTBEAT_INTERVAL_MS` in `packages/shared-config/src/heartbeat.ts` |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
| Postgres pool | `max: 4`, `prepare: false` | `DEFAULT_POSTGRES_OPTIONS` in `packages/worker-kit/src/run-worker.ts` |
| Postgres close timeout on shutdown | 5 s | `POSTGRES_END_TIMEOUT_SECONDS` |
| Redis retry delay | `min(2000, 200 * 2^min(attempt, 6))` ms | `defaultRuntime.createRedis` in `run-worker.ts` |

## Compose service

Service `worker-clan-priority-expirer` has `restart: unless-stopped`, the shared hardening block (`cap_drop: [ALL]`, `no-new-privileges`, `pids_limit: 256`, `init`, read-only root filesystem with `/tmp` as tmpfs) and the worker limits (`mem_limit: 512m`, `cpus: 1.0`). It has no `user:` override, no bridge socket mount and no volumes. In `docker/compose.yml` it waits for `postgres` and `redis` to be healthy and for the `migrator` service to complete; the stand file waits for `postgres` and `redis` only.
