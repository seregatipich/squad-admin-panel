# worker-clan-guard - Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | - | PostgreSQL connection string. A missing value is logged as `DATABASE_URL is required` (fatal) and the process exits with code 1. | yes |
| `REDIS_URL` | yes | - | Redis connection string, used for the heartbeat, `diag:queue` and the `rcon:commands:<serverId>` streams. A missing value is fatal in the same way. | yes |
| `CLAN_GUARD_INTERVAL_MS` | no | `120000` | Tick interval in milliseconds, parsed by `positiveIntEnv` in `src/index.ts`. A blank value falls back to the default; a value that is not a positive integer throws when the module loads and the worker fails at startup. | no |
| `LOG_LEVEL` | no | `info` | Pino log level, read by `createWorkerLog`. Neither compose file passes it to this service. | no |

`docker/compose.yml` and `docker/compose.stand.yml` pass `DATABASE_URL`, `REDIS_URL` and `CLAN_GUARD_INTERVAL_MS` (default `120000`). The stand file also sets `WORKER: clan-guard` for the shared workers image; `docker/compose.yml` builds `docker/worker.Dockerfile` with `WORKER: clan-guard`.

## Runtime settings (database)

The behavior switches live in the singleton table `clan_guard_settings` (row `id = 1`), edited through `PATCH /api/v1/settings/clan-guard`:

| Column | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Kill-switch. When `false` the tick returns immediately and emits `clan_guard.skipped_disabled`. |
| `grace_period_seconds` | `300` | Seconds between the first warn of a session and the kick. Must be `>= 0`; the API accepts 0 through 3600. |

If the row does not exist the worker behaves as if `enabled = true` and `grace_period_seconds = 300`. Per-clan protection is the `clans.is_tag_protected` flag.

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| RCON stream length cap | `MAXLEN ~ 500` | `RCON_STREAM_MAXLEN` in `src/deps.ts` |
| Moderation ledger action type | `clan_tag_protection` | `src/deps.ts` |
| Audit action types | `clan.tag_protection.warn`, `clan.tag_protection.kick` | `src/deps.ts` |
| Heartbeat interval / TTL | 5 000 ms / 30 s | `packages/shared-config/src/heartbeat.ts` |
| Postgres pool | `max: 4`, `prepare: false` | `packages/worker-kit/src/run-worker.ts` |

## Compose service

Service `worker-clan-guard` has `restart: unless-stopped`, the shared hardening block (`cap_drop: [ALL]`, `no-new-privileges`, `pids_limit: 256`, `init`, read-only root filesystem with `/tmp` as tmpfs) and the worker limits (`mem_limit: 512m`, `cpus: 1.0`). It needs no bridge socket, so it has no `user:` override and no volumes. In `docker/compose.yml` it waits for `postgres` and `redis` to be healthy and for `migrator` to complete; the stand file waits for `postgres` and `redis` only.
