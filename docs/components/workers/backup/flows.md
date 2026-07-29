# worker-backup — Flows

## Startup

1. Start pino logger.
2. Log `"worker-backup idle — deferred to later phase"` once.
3. If `REDIS_URL` is set, create an `ioredis` client and call `startHeartbeat` (`worker:heartbeat:backup`, status `"idle (P2)"`, published every 5 s with TTL 30 s). If `REDIS_URL` is unset, skip both — no client, no heartbeat.
4. Register `SIGINT`/`SIGTERM` handlers.

There is no periodic idle loop beyond the heartbeat interval; after startup the process simply waits on a signal. Restic snapshot/domain logic is deferred to a later phase and is not part of this flow.

## Graceful shutdown

On `SIGINT`/`SIGTERM`: stop the heartbeat interval → `redis.quit()` (if a client exists) → `process.exit(0)`.
