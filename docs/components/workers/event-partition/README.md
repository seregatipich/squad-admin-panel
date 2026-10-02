# worker-event-partition

## Purpose

Ensures Postgres tables that are partitioned by time always have a partition ready for incoming writes. Runs as an hourly cron replacement for `pg_partman`'s `run_maintenance`. Manages six partitioned tables:

- `events` — monthly partitions with **24-month retention**. Worker keeps the current + next month partitions present and drops every partition whose name sorts before the `date_trunc('month', now()) - 24 months` cutoff. Initial partitions also come from `packages/db/drizzle/0000_init.sql`.
- `diagnostic_events` — daily partitions with **24h retention**. Worker actively keeps `[-1, 0, +1, +2]` days from today present and drops every partition whose name sorts before yesterday (i.e. its entire range is more than 24h in the past).
- `player_sessions` — monthly partitions, current + next month kept present (`ensurePlayerSessionPartitions`), nothing dropped.
- `chat_messages`, `bonus_transactions`, `combat_events` — monthly partitions with a DEFAULT catch-all, current + next month kept present (`ensureDefaultBackedMonthlyPartitions`), rows already parked in DEFAULT for a new month moved into it, nothing dropped. Their migrations created only a fixed window of months; without this rotation chat, bonus-ledger and VIP-grant inserts fail from the first day past it (issue #6).

It also applies the retention of the unpartitioned journal tables (`pruneJournalTables`, `src/retention.ts`, issue #77), in batches of 5 000 rows:

| Table | Removed after |
|---|---|
| `alert_events` | 90 days when delivered, 365 days otherwise; rows an `expiry_notifications` row references are kept |
| `admins_cfg_sync_outbox` | 30 days after `relayed_at` (pending rows are never removed) |
| `scheduled_task_runs` | 90 days, and at most the newest 1 000 rows per task (`pruneScheduledTaskRuns`) |
| `chat_command_invocations`, `automation_runs` | 90 days |
| `media_upload_tokens` | 7 days after expiry or use; tokens a `media_files` row references are kept |
| `ban_appeals.submitter_ip` | set to NULL 30 days after the decision, 90 days after submission at the latest |

## Current status — fully implemented

Every rotation is fully implemented and idempotent (`CREATE TABLE IF NOT EXISTS` / `DROP TABLE IF EXISTS` / an existence check). No pg_partman.

## What it does not do

- Does not read from or write to Redis Streams.
- Does not interact with the bridge.
- Does not detach/archive dropped partitions before dropping them — a dropped partition's data is gone, not moved to cold storage.
- Does not retain `diagnostic_events` data beyond ~48h (yesterday + today + 2 future days exist; any older child is dropped on the next hourly tick).
- Does not retain `events` data beyond 24 months.
- Does not keep `processed_events` markers older than the `events` retention cutoff: `pruneProcessedEvents` deletes them on every tick (#62).
- Does not apply any retention to `player_sessions`, `chat_messages`, `bonus_transactions` or `combat_events`.

## Code location

```
apps/workers/event-partition/
  src/
    index.ts      — hourly loop, Postgres connection, heartbeat, partition rotation
    retention.ts  — journal-table retention (`pruneJournalTables`, `JOURNAL_RETENTION`)
```

## Dependencies

- `@squad/shared-config` — `startHeartbeat`
- `postgres` — raw SQL client (`postgres` package, not Drizzle)
- `ioredis` — Redis client (for heartbeat)

The full retention-window table lives in [configuration.md](./configuration.md#journal-table-retention-windows).

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
