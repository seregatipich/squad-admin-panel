# worker-rcon — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string | yes |
| `REDIS_URL` | yes | — | ioredis connection string | yes |
| `APP_ENCRYPTION_KEY` | yes | — | Base64-encoded 32-byte AES key for RCON password blobs | yes |
| `LOG_LEVEL` | no | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) | no |
| `BRIDGE_SOCKET` | no | — | Not used by this worker | — |

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Reconcile interval | 15 000 ms | `apps/workers/rcon/src/index.ts` |
| Poll interval | 30 000 ms | `PerServerSupervisor.schedulePoll` |
| Keepalive interval | 90 000 ms | `RconClient.keepalive` |
| Connect timeout | 5 000 ms | `RconClient.connect` |
| Auth timeout | 5 000 ms | `RconClient.authenticate` |
| Command timeout | 10 000 ms | `RconClient.exec` |
| Initial reconnect backoff | 1 000 ms | `PerServerSupervisor` |
| Max reconnect backoff | 60 000 ms | `PerServerSupervisor` |
| `rcon:status` TTL | 300 s | `PerServerSupervisor.writeStatus` |
| Heartbeat interval | 5 000 ms | `startHeartbeat` default |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
| Event stream MAXLEN | ~10 000 | `PerServerSupervisor.emitEvent` |

## Compose user requirement

The worker does not need the host bridge. No special `user:` entry is required beyond the default compose user.

## Redis retry strategy

```
delay = min(2000, 200 * 2^min(attempt, 6))  ms
```

Capped at 2 s after ~6 attempts.
