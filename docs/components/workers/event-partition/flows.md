# worker-event-partition — Flows

## Startup

1. Read `DATABASE_URL` from environment; fatal-exit if missing.
2. Connect to Postgres (`max: 1` connection pool).
3. Connect to Redis if `REDIS_URL` is set.
4. Call `ensurePartitions()` immediately.
5. Start `setInterval(ensurePartitions, 3_600_000)` (1 h).
6. Start heartbeat (`worker:heartbeat:event-partition`, every 5 s).

## `ensurePartitions()` (current placeholder)

Executes `SELECT 1` twice (current + next month slots). Logs `{ createdUpTo: 2 }`. No actual DDL in P0.

## Planned Phase 1 `ensurePartitions()`

1. Compute current month and next month as `YYYY_MM` strings.
2. For each: `CREATE TABLE IF NOT EXISTS events_{YYYY_MM} PARTITION OF events FOR VALUES FROM (...) TO (...)`.
3. On the 25th of the month, also pre-create the month after next.
4. Detach partitions older than 12 months.

## Graceful shutdown (SIGTERM / SIGINT)

Stop heartbeat → `sql.end({ timeout: 5 })` → `redis.quit()` → `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| `ensurePartitions` DDL error | Log error; skip this cycle; retry on next tick |
| Postgres unavailable on start | Fatal exit (no connection = no meaningful work) |
| Redis unavailable | Heartbeat silently skipped; worker continues |
