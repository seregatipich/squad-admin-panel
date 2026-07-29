# worker-backup — Data model

No Postgres tables are read or written by this worker.

## Redis keys

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `worker:heartbeat:backup` | string (JSON) | 30 s | `startHeartbeat` (`@squad/shared-config`) | Liveness heartbeat, published every 5 s while `REDIS_URL` is set. `status` field is always `"idle (P2)"`. |
