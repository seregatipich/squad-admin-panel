# worker-event-partition — Troubleshooting

## `events` inserts fail with "no partition of relation 'events' found for row"

**Cause:** The current month's partition does not exist.

**Fix:** In P0, bootstrap partitions are created by `packages/db/drizzle/0000_init.sql`. If the panel is running past the date range covered by that migration, manually create the missing partition:

```sql
CREATE TABLE IF NOT EXISTS events_YYYY_MM
  PARTITION OF events
  FOR VALUES FROM ('YYYY-MM-01 00:00:00+00') TO ('YYYY-MM+1-01 00:00:00+00');
```

When Phase 1 ships, the worker will handle this automatically.

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
