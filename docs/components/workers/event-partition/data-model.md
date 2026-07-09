# worker-event-partition — Data model

## Postgres tables managed

### `events` (partitioned table)

Declared in `packages/db/src/schema/events.ts`. Partitioned by `occurred_at` (range, monthly).

Initial 6 monthly partitions (current + 5 look-ahead months) are bootstrapped by `packages/db/drizzle/0000_init.sql`.

The worker keeps the current + next month partitions present (`ensureMonthlyPartitions`, hourly) and drops any partition entirely older than the 24-month retention window — a dropped partition's rows are gone, not archived elsewhere.

#### Partition naming convention

```
events_YYYY_MM
```

Example: `events_2026_04` covers `2026-04-01` to `2026-05-01`.

The `relname` lexicographic ordering on `events_YYYY_MM` matches calendar ordering, which is why the drop query uses `WHERE p.relname < 'events_<YYYY_MM of 24 months ago>'`.

### `diagnostic_events` (partitioned table)

Declared by migration `packages/db/drizzle/0017_diagnostic_events.sql`. Partitioned by `ts` (range, daily). Schema (id uuid, ts timestamptz, component, severity, kind, server_id, actor_steam_id64, request_id, message, payload jsonb).

Initial 25 daily partitions (yesterday + today + 23 future) are bootstrapped by the migration. The worker takes over from the next hourly tick and keeps `[-1, 0, +1, +2]` days from `current_date` present, dropping anything older than yesterday.

**UTC invariant.** Partition bounds and names are computed in UTC by the worker (via `Date.toISOString()`). Production Postgres MUST run with `TimeZone = 'UTC'` (or behave equivalently for date arithmetic) so the worker's UTC-derived names align with any partitions created from session-TZ-dependent SQL. Migration `0018_diagnostic_events_utc_invariant.sql` documents this contract; any non-UTC bootstrap partitions written by the original `0017` loop age out within 24h via the worker's drop-stale sweep, after which the system converges.

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
