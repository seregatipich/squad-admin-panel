# worker-event-partition

## Purpose

Ensures Postgres tables that are partitioned by time always have a partition ready for incoming writes. Runs as an hourly cron replacement for `pg_partman`'s `run_maintenance`. Manages two partitioned tables:

- `events` — monthly partitions with **24-month retention**. Worker keeps the current + next month partitions present and drops every partition whose name sorts before the `date_trunc('month', now()) - 24 months` cutoff. Initial partitions also come from `packages/db/drizzle/0000_init.sql`.
- `diagnostic_events` — daily partitions with **24h retention**. Worker actively keeps `[-1, 0, +1, +2]` days from today present and drops every partition whose name sorts before yesterday (i.e. its entire range is more than 24h in the past).

## Current status — fully implemented

Both the `events` and `diagnostic_events` rotations are fully implemented and idempotent (`CREATE TABLE IF NOT EXISTS` / `DROP TABLE IF EXISTS`). No pg_partman.

## What it does not do

- Does not read from or write to Redis Streams.
- Does not interact with the bridge.
- Does not detach/archive dropped partitions before dropping them — a dropped partition's data is gone, not moved to cold storage.
- Does not retain `diagnostic_events` data beyond ~48h (yesterday + today + 2 future days exist; any older child is dropped on the next hourly tick).
- Does not retain `events` data beyond 24 months.

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
