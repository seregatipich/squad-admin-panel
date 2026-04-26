# worker-event-partition — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string | yes |
| `REDIS_URL` | no | — | ioredis connection string. If unset heartbeat is not published. | yes |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

## Hard-coded constants

| Constant | Value | Location |
|---|---|---|
| Partition maintenance interval | 3 600 000 ms (1 h) | `apps/workers/event-partition/src/index.ts` |
| Postgres pool size | 1 connection | `index.ts` |
| Heartbeat interval | 5 000 ms | `startHeartbeat` default |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
