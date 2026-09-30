# worker-event-partition — Flows

## Startup

1. Read `DATABASE_URL` from environment; fatal-exit if missing.
2. Connect to Postgres (`max: 1` connection pool).
3. Connect to Redis if `REDIS_URL` is set.
4. Call `runPartitionTick({ sql, diag })` immediately. It runs `ensureMonthlyPartitions(sql)` (events), `ensureDiagPartitions(sql)` (diagnostic_events), `ensurePlayerSessionPartitions(sql)` (player_sessions), `pruneProcessedEvents(sql)` (deletes `processed_events` rows whose `processed_at` is older than the 24-month `events` cutoff) and `ensureDefaultBackedMonthlyPartitions(sql, table)` for each of `chat_messages`, `bonus_transactions` and `combat_events` concurrently via `Promise.allSettled`, then emits `event_partition.run_ok` / `event_partition.run_failed`.
5. Start `setInterval(runPartitionTick, 3_600_000)` (1 h).
6. Start heartbeat (`worker:heartbeat:event-partition`, every 5 s).

## `ensureMonthlyPartitions(sql)` (active)

Exported from `apps/workers/event-partition/src/index.ts`. Idempotent maintenance for the `events` partitioned table, mirroring `ensureDiagPartitions` below exactly:

1. **Create buffer**: for the current month and next month, run `CREATE TABLE IF NOT EXISTS events_<YYYY_MM> PARTITION OF events FOR VALUES FROM ('<month-start>') TO ('<next-month-start>');`. Date math uses UTC (`Date.UTC`). One info log per call: `ensured events partition`.
2. **Drop stale**: compute `cutoffName = 'events_<YYYY_MM>'` for `date_trunc('month', now()) - interval '24 months'`. Query `pg_inherits` joined to `pg_class` for child partitions of `events` whose `relname < cutoffName`. For each match, run `DROP TABLE IF EXISTS <partname>;`. One info log per drop: `dropped stale events partition`.

Why current + next month only? The initial 6-month bootstrap in `packages/db/drizzle/0000_init.sql` already covers a wide look-ahead window; the hourly rotation only needs to keep rolling that window forward by one month at a time.

## `ensureDefaultBackedMonthlyPartitions(sql, table)` (active)

For `chat_messages`, `bonus_transactions` and `combat_events` (issue #6), for the current month and next month (UTC):

1. If `<name>_YYYY_MM` already exists, do nothing.
2. Otherwise, in one transaction (a `DO` block): lock `<name>_default` `ACCESS EXCLUSIVE`, create `<name>_YYYY_MM` as `LIKE <name> INCLUDING DEFAULTS INCLUDING CONSTRAINTS`, move the DEFAULT partition's rows for the month into it, and `ATTACH PARTITION … FOR VALUES FROM ('<month-start>') TO ('<next-month-start>')`.

The move exists because Postgres refuses to add a partition whose range the DEFAULT partition still holds rows for (`updated partition constraint for default partition would be violated`). Normally the DEFAULT partition is empty for the next month and the lock is held for milliseconds, once per table per month. Nothing is dropped. Migration `0117_monthly_partition_defaults` created the DEFAULT partitions of `chat_messages` and `bonus_transactions` and ran the same steps for the current month and three months ahead.

## `ensureDiagPartitions(sql)` (active)

Exported from `apps/workers/event-partition/src/index.ts`. Idempotent maintenance for the `diagnostic_events` partitioned table:

1. **Create buffer**: for each offset in `[-1, 0, +1, +2]` days from today, run `CREATE TABLE IF NOT EXISTS diagnostic_events_<YYYYMMDD> PARTITION OF diagnostic_events FOR VALUES FROM ('<from>') TO ('<from + 1 day>');`. Date math uses UTC (`Date#toISOString().slice(0,10)`). One info log per call: `ensured diag partition`.
2. **Drop stale**: compute `cutoffName = 'diagnostic_events_<yesterday-yyyymmdd>'`. Query `pg_inherits` joined to `pg_class` for child partitions of `diagnostic_events` whose `relname < cutoffName`. For each match, run `DROP TABLE IF EXISTS <partname>;`. One info log per drop: `dropped stale diag partition`.

Why `[-1, +2]`?

- `-1` (yesterday) — kept for ~24h after the day rolls over so any late-arriving entry from `worker-diag-flush` (entries that were XADD'd just before midnight but ACK'd in the next minute) does not error out.
- `0` (today) — required for the live insert path. Without today's partition, every `INSERT INTO diagnostic_events` from `worker-diag-flush` would fail.
- `+1` (tomorrow) — pre-created so the rollover at midnight UTC is seamless.
- `+2` (day after tomorrow) — safety buffer if the worker crash-loops or misses a tick.

## Graceful shutdown (SIGTERM / SIGINT)

Stop heartbeat → `clearInterval(interval)` → `sql.end({ timeout: 5 })` → `redis.quit()` → `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| `runPartitionTick()` DDL error | Logged, isolated to the failing rotation via `Promise.allSettled`, `event_partition.run_failed` emitted; the other rotation still completes; retry on next interval tick |
| Postgres unavailable on start | Fatal exit (no connection = no meaningful work) |
| Redis unavailable | Heartbeat silently skipped; worker continues |
| `diagnostic_events` parent table missing | DDL fails for both create and drop branches; logs at `error`; partitions never get rotated until migration `0017_diagnostic_events.sql` has run |
| `<name>_default` partition missing for `chat_messages` / `bonus_transactions` / `combat_events` | The `LOCK TABLE` fails; logs at `error`, `event_partition.run_failed`; resolved by running migration `0117_monthly_partition_defaults` |
| `events` parent table missing | DDL fails for both create and drop branches in `ensureMonthlyPartitions`; logs at `error`; isolated from the diag rotation by `Promise.allSettled` |
