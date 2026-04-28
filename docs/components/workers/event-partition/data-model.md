# worker-event-partition — Data model

## Postgres tables managed

### `events` (partitioned table)

Declared in `packages/db/src/schema/events.ts`. Partitioned by `occurred_at` (range, monthly).

Initial partitions bootstrapped by `packages/db/drizzle/0000_init.sql`.

This worker creates future partitions. In Phase 1 it will also detach and archive partitions older than 12 months.

#### Partition naming convention

```
events_YYYY_MM
```

Example: `events_2026_04` covers `2026-04-01` to `2026-05-01`.

### `diagnostic_events` (partitioned table)

Declared by migration `packages/db/drizzle/0017_diagnostic_events.sql`. Partitioned by `ts` (range, daily). Schema (id uuid, ts timestamptz, component, severity, kind, server_id, actor_steam_id64, request_id, message, payload jsonb).

Initial 25 daily partitions (yesterday + today + 23 future) are bootstrapped by the migration. The worker takes over from the next hourly tick and keeps `[-1, 0, +1, +2]` days from `current_date` present, dropping anything older than yesterday.

#### Partition naming convention

```
diagnostic_events_YYYYMMDD
```

Example: `diagnostic_events_20260428` covers `2026-04-28` to `2026-04-29`.

The `relname` lexicographic ordering on `diagnostic_events_YYYYMMDD` matches calendar ordering, which is why the drop query uses `WHERE p.relname < 'diagnostic_events_<yyyymmdd of yesterday>'`.

## Redis keys

| Key | TTL | Description |
|---|---|---|
| `worker:heartbeat:event-partition` | 30 s | Liveness heartbeat |
