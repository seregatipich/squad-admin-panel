# worker-event-partition — Data model

## Postgres tables managed

### `events` (partitioned table)

Declared in `packages/db/src/schema/events.ts`. Partitioned by `occurred_at` (range, monthly).

Initial partitions bootstrapped by `packages/db/drizzle/0000_init.sql`.

This worker creates future partitions. In Phase 1 it will also detach and archive partitions older than 12 months.

### Partition naming convention

```
events_YYYY_MM
```

Example: `events_2026_04` covers `2026-04-01` to `2026-05-01`.

## Redis keys

| Key | TTL | Description |
|---|---|---|
| `worker:heartbeat:event-partition` | 30 s | Liveness heartbeat |
