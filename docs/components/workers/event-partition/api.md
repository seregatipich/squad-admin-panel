# worker-event-partition — API surface

No HTTP surface and no Redis stream output.

## Heartbeat key: `worker:heartbeat:event-partition`

Published every 5 s (default interval), TTL 30 s.

`status` field: `"idle"`.

## Diagnostic events (`diag:queue` Redis Stream)

The worker emits structured `DiagEvent`s via `@squad/diag` (`createDiag({ redis, log })` constructed once at startup). All kinds carry `component: 'worker-event-partition'`. Each emit is `await`ed but never thrown — `Diag.emit` swallows Redis failures and falls back to pino, so telemetry never derails the rotation tick.

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `event_partition.started` | `info` | Right after `startHeartbeat`, before the first `runPartitionTick` | `pid: number` |
| `event_partition.run_ok` | `info` | A successful hourly tick (both monthly + daily diag rotations resolved). | `{}` |
| `event_partition.run_failed` | `error` | One or more sub-rotations rejected. The tick still continues — failures are isolated per-rotation via `Promise.allSettled`. | `failures: string[]` (the rejected error messages) |
| `event_partition.stopped` | `info` | Inside the SIGTERM/SIGINT handler before `process.exit(0)`. | `sig: 'SIGTERM' \| 'SIGINT'` |

## Exported functions

### `ensureDiagPartitions(sql: postgres.Sql): Promise<void>`

Idempotent rotator for the `diagnostic_events` daily partitions.

- **Input**: a `postgres-js` `Sql` instance (the worker passes its own `postgres(databaseUrl, { max: 1 })` connection).
- **Output**: `Promise<void>`.
- **Side effects on Postgres**:
  - Issues four `CREATE TABLE IF NOT EXISTS diagnostic_events_<YYYYMMDD> PARTITION OF diagnostic_events FOR VALUES FROM ('<from>') TO ('<from + 1 day>');` for offsets `[-1, 0, +1, +2]` from today (UTC dates from `Date#toISOString().slice(0, 10)`).
  - Issues `DROP TABLE IF EXISTS diagnostic_events_<YYYYMMDD>;` for every child of `diagnostic_events` whose `relname` sorts strictly before yesterday's `diagnostic_events_<YYYYMMDD>` (24h retention).
- **Side effects on logs**: one `info` line per CREATE (`ensured diag partition`) and one per DROP (`dropped stale diag partition`), each with a `partname` field.
- **Errors**: any DDL error or query error propagates to the caller. The worker's hourly `tick()` logs and continues.

Example call from a unit test:

```ts
import { ensureDiagPartitions } from '@squad/worker-event-partition';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await ensureDiagPartitions(sql);
```

## Side effects on Postgres (events table — Phase 1 placeholder)

The worker issues DDL against the `events` partitioned table. In Phase 1 this will be:

```sql
CREATE TABLE IF NOT EXISTS events_YYYY_MM
  PARTITION OF events
  FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01');
```

No data is returned to callers. The DDL is idempotent (`IF NOT EXISTS`).
