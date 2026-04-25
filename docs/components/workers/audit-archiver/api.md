# worker-audit-archiver — API surface

No HTTP surface and no Redis stream output in the current P0 stub.

## Heartbeat key: `worker:heartbeat:audit-archiver`

Published every 5 s (default interval), TTL 30 s.

`status` field: `"idle (P1)"` — indicates Phase 1 archival logic is not yet active.

## Planned Phase 1 surface

When Phase 1 ships, this worker will write archive bundle metadata to a Redis key or stream so the panel's audit UI can display the last archive run timestamp and row count.
