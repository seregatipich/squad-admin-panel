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
| `diagnostic_events` retention | 24h (any partition older than yesterday is dropped) | `ensureDiagPartitions` in `index.ts` |
| `diagnostic_events` create-buffer | `[-1, 0, +1, +2]` days from today | `ensureDiagPartitions` in `index.ts` |
| `events` retention | 24 months (`EVENTS_RETENTION_MONTHS`) | `ensureMonthlyPartitions` in `index.ts` |
| `events` create-buffer | current + next month | `ensureMonthlyPartitions` in `index.ts` |

The `diagnostic_events` and `events` retention/buffer values are not currently exposed as env vars — change them in code if a tuning need arises.
