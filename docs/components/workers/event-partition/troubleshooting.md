# worker-event-partition — Troubleshooting

## `events` inserts fail with "no partition of relation 'events' found for row"

**Cause:** The current month's partition does not exist. `ensureMonthlyPartitions` runs hourly and should self-heal within an hour; this only happens if the worker has been down for longer than that, or Postgres rejected its DDL (check logs for `partition rotation tick rejected` / `event_partition.run_failed`).

**Fix:** Bootstrap partitions are created by `packages/db/drizzle/0000_init.sql`; `ensureMonthlyPartitions` (in `apps/workers/event-partition/src/index.ts`) keeps the current + next month partitions rolling forward on every hourly tick. If the worker has been down long enough that the gap exceeds the bootstrap window, manually create the missing partition:

```sql
CREATE TABLE IF NOT EXISTS events_YYYY_MM
  PARTITION OF events
  FOR VALUES FROM ('YYYY-MM-01 00:00:00+00') TO ('YYYY-MM+1-01 00:00:00+00');
```

## Heartbeat missing from `/api/v1/health/workers`

**Cause:** `REDIS_URL` is not set.

**Fix:** Add `REDIS_URL` to the compose environment for this worker.

## Worker fatal-exits on startup

**Cause:** `DATABASE_URL` is not set or Postgres is unreachable.

```bash
docker compose logs worker-event-partition --since 2m
```

## Useful commands

```bash
# List existing partitions
psql $DATABASE_URL -c "\d+ events"

# Check worker heartbeat
redis-cli GET worker:heartbeat:event-partition
```
