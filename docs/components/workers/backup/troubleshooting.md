# worker-backup — Troubleshooting

Restic/domain backup logic is deferred to a later phase; the process should otherwise idle without errors.

**Container restarting:** `docker compose logs worker-backup --since 5m`.

**No heartbeat key in Redis:** Check whether `REDIS_URL` is set. If it is unset, no heartbeat is published by design — set `REDIS_URL` to enable it. If `REDIS_URL` is set and the `worker:heartbeat:backup` key is still missing, the process has crashed or cannot reach Redis — check the container logs and Redis connectivity.
