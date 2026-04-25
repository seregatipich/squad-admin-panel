# worker-event-partition

## Purpose

Ensures the `events` Postgres table always has a partition ready for the current and next calendar month. Runs as an hourly cron replacement for `pg_partman`'s `run_maintenance`.

## Current status — partially implemented

The worker runs on a real hourly interval and connects to Postgres, but the partition DDL logic is a placeholder (`SELECT 1`). The initial partitions are created by `packages/db/drizzle/0000_init.sql`. Full pre-creation and detachment logic is deferred to Phase 1.

## What it does not do

- Does not read from or write to Redis Streams.
- Does not interact with the bridge.
- Does not detach or archive old partitions (Phase 1).

## Code location

```
apps/workers/event-partition/
  src/
    index.ts    — hourly loop, Postgres connection, heartbeat
```

## Dependencies

- `@squad/shared-config` — `startHeartbeat`
- `postgres` — raw SQL client (`postgres` package, not Drizzle)
- `ioredis` — Redis client (for heartbeat)

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
