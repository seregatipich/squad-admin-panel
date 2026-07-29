# worker-backup — API surface

No HTTP surface. The worker's only public contract is a heartbeat key.

## Heartbeat key: `worker:heartbeat:backup`

Published every 5 s (default interval), TTL 30 s — only when `REDIS_URL` is set. If `REDIS_URL` is unset, no Redis client is created and the key is never published.

`status` field: `"idle (P2)"` — indicates restic/domain backup logic is not yet active in this worker (the actual scheduled backups run in the separate `backup` docker-compose service; see [README.md](./README.md)).
