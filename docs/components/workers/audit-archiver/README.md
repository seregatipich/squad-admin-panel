# worker-audit-archiver

## Purpose

Cold-archives `audit_log` rows older than 90 days to preserve the verified SHA-256 hash chain outside the hot Postgres table. Runs on a scheduled basis and removes archived rows from the live table via a `SECURITY DEFINER` view that bypasses the append-only trigger.

## Current status — P0 stub

The worker is deployed and publishes a heartbeat, but the archival logic is deferred to Phase 1. The current `src/index.ts` is a no-op loop that logs `"idle (P1)"` and publishes `worker:heartbeat:audit-archiver`.

Phase 1 will implement:

- Hourly scan of `audit_log` for rows older than 90 days.
- JSONL export to a restic repository on the host filesystem.
- Deletion of exported rows via `audit_log_archive_view` (SECURITY DEFINER).

## What it does not do

- Does not modify, truncate, or reorder any `audit_log` row (the table has a BEFORE UPDATE/DELETE trigger that raises an error).
- Does not read from Redis Streams.
- Does not interact with the bridge.

## Code location

```
apps/workers/audit-archiver/
  src/
    index.ts    — P0 stub: heartbeat only
```

## Dependencies

- `@squad/shared-config` — `startHeartbeat`
- `ioredis` — Redis client (for heartbeat)

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
