# worker-audit-archiver — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `REDIS_URL` | no | — | ioredis connection string. If unset the heartbeat is not published. | yes |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

No `DATABASE_URL` is consumed in the P0 stub. Phase 1 will add it as required.

## Hard-coded constants (P0)

| Constant | Value | Notes |
|---|---|---|
| Heartbeat interval | 5 000 ms | `startHeartbeat` default |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
