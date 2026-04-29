# worker-log-ingest — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string | yes |
| `REDIS_URL` | yes | — | ioredis connection string | yes |
| `BRIDGE_SOCKET` | no | `/run/panel-host-bridge/bridge.sock` | Path to the host bridge Unix socket | no |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

## Hard-coded constants

| Constant | Value | Location |
|---|---|---|
| Reconcile interval | 15 000 ms | `apps/workers/log-ingest/src/index.ts` |
| Log tail `tail` param | 100 lines | `tail.ts` (bridge `containerLogsFollow`) |
| Rate-reporting interval | 60 000 ms | `tail.ts` |
| Heartbeat interval | 5 000 ms | `startHeartbeat` default |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
| Event stream MAXLEN | ~10 000 | `publish.ts` |
| Dedup TTL | 86 400 s | `DEDUP_TTL_SECONDS` in `shared-types` |
| Join-correlation window | 2 500 ms | `LogIngestor` constructor |

## Compose user requirement

Requires `user: "0:${PANEL_GID:-987}"` (primary GID `panel`) in `compose.yml` so the bridge's `SO_PEERCRED` check passes. `group_add: panel` is insufficient because supplementary groups are not visible across the host user namespace boundary.
