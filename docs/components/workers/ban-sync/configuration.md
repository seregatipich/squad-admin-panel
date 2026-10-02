# worker-ban-sync - Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | - | PostgreSQL connection string (pool `max: 4`, `prepare: false`). Missing: `DATABASE_URL is required` is logged as fatal and the process exits with code 1. | yes |
| `REDIS_URL` | yes | - | Redis connection string; the worker opens one connection plus a duplicate for the blocking manual-queue read. Missing is fatal in the same way. | yes |
| `APP_ENCRYPTION_KEY` | yes | - | Base64 key that must decode to exactly 32 bytes (AES-256-GCM). Decrypts `external_ban_sources.auth_header_encrypted`. Missing is fatal; a key of the wrong length makes `createSyncSourceDeps` throw `APP_ENCRYPTION_KEY must decode to 32 bytes, got <n>` and the process exits with code 1. | yes |
| `BAN_SYNC_INTERVAL_MS` | no | `60000` | Interval of the scheduled tick, parsed by `positiveIntEnv` in `src/index.ts`. | no |
| `BAN_SYNC_FETCH_TIMEOUT_MS` | no | `30000` | Hard timeout for one download, headers and body together (`src/fetch-source.ts`). | no |
| `BAN_SYNC_MAX_BYTES` | no | `20971520` (20 MiB) | Hard cap on the response body (`src/fetch-source.ts`). | no |
| `LOG_LEVEL` | no | `info` | Pino log level. The logger is created directly with `pino` and tagged `service: "worker-ban-sync"`. | no |

`positiveIntEnv` returns the default for an unset or blank variable and throws `<NAME> must be a positive integer, got "<value>"` for anything that is not a positive integer. The three `BAN_SYNC_*` values are read when their module loads, so an invalid value stops the worker at startup.

`docker/compose.yml` and `docker/compose.stand.yml` pass `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY` and `BAN_SYNC_INTERVAL_MS` (default `60000`). `BAN_SYNC_FETCH_TIMEOUT_MS`, `BAN_SYNC_MAX_BYTES` and `LOG_LEVEL` are not passed, so they keep their defaults unless added to the service's `environment`. The stand file also sets `WORKER: ban-sync` for the shared workers image; `docker/compose.yml` builds `docker/worker.Dockerfile` with `WORKER: ban-sync`.

## Per-source settings (database)

Configured through the API in `external_ban_sources`; the worker reads them on every tick:

| Column | Effect on the worker |
|---|---|
| `enabled` | Only enabled sources are listed for the scheduled tick. A manual job syncs the source even when it is disabled (the lookup does not filter on `enabled`). |
| `poll_interval_minutes` | Minimum time between syncs: due when `last_sync_at + poll_interval_minutes * 60 s <= now`. Default 60, constraint `>= 15`. |
| `url`, `auth_header_encrypted` | What to fetch and the optional `Authorization` header (sent as stored, decrypted). |
| `format` | `squad_bans_cfg`, `battlemetrics_json`, `json_generic` or `csv`. |
| `parser_config` | Field mapping for the JSON and CSV adapters (see [flows.md](./flows.md)). |
| `consecutive_failures` | Input to the backoff delay and the third-failure alert. |

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Manual-queue block time | 5 000 ms | `MANUAL_BLOCK_MS` in `src/index.ts` |
| Pause after a failed read or group creation | 1 000 ms | `src/manual-queue.ts` |
| Backoff base / cap | 60 s / 60 min | `BASE_BACKOFF_MS`, `MAX_BACKOFF_MS` in `src/tick.ts` |
| Failure-alert threshold | 3 consecutive failures | `ALERT_CONSECUTIVE_FAILURE_THRESHOLD` in `src/sync-source.ts` |
| Redirect hops followed | 5 | `MAX_REDIRECTS` in `src/fetch-source.ts` |
| Insert / revoke batch | 1 000 rows or ids | `MERGE_BATCH_SIZE` in `src/merge.ts` |
| Update batch | 500 rows | `UPDATE_BATCH_ROWS` in `src/merge.ts` |
| `events:global` length cap | `MAXLEN ~ 10000` | `src/events.ts` |
| Dedup key TTL | 86 400 s | `DEDUP_TTL_SECONDS` in `packages/shared-types/src/events.ts` |
| Heartbeat interval / TTL | 5 000 ms / 30 s | `packages/shared-config/src/heartbeat.ts` |
| Postgres close timeout on shutdown | 5 s | `src/index.ts` |
| Redis retry delay | `min(2000, 200 * 2^min(attempt, 6))` ms | `src/index.ts` |

## Compose service

Service `worker-ban-sync` has `restart: unless-stopped`, the shared hardening block (`cap_drop: [ALL]`, `no-new-privileges`, `pids_limit: 256`, `init`, read-only root filesystem with `/tmp` as tmpfs) and the worker limits (`mem_limit: 512m`, `cpus: 1.0`). It needs no bridge socket, so it has no `user:` override and no volumes; it makes outbound HTTP(S) requests to the configured source URLs. In `docker/compose.yml` it waits for `postgres` and `redis` to be healthy and for `migrator` to complete; the stand file waits for `postgres` and `redis` only.
