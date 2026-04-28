# worker-diag-flush — Flows

## Startup

1. `main()` reads `DATABASE_URL` (required, fatal exit on miss) and `REDIS_URL` (optional, default `redis://localhost:6379`).
2. Creates the Postgres pool with `postgres(databaseUrl, { max: 2 })` — two connections is plenty: one used by the active INSERT, one for the heartbeat retries during a slow flush.
3. Creates the Redis client with `maxRetriesPerRequest: null, enableReadyCheck: false`. Both are required for blocking `XREADGROUP` calls.
4. Wires `redis.on('error')` and `redis.on('reconnecting')` to pino warn/info — never `error`-level, because ioredis retries internally.
5. Issues `XGROUP CREATE diag:queue diag-flush $ MKSTREAM`. If `BUSYGROUP` (group already exists from a prior run), swallows the error. Any other error rethrows and crashes the process.
6. Starts the heartbeat publisher (`worker:heartbeat:diag-flush`, 5 s interval, 30 s TTL, status `'ok'`).
7. Registers `SIGINT` and `SIGTERM` handlers (see "Shutdown" below).
8. Logs `worker-diag-flush ready` with the group name, consumer name, and batch size.
9. Enters the main loop.

## Main flow — flush

Per loop iteration:

1. Issue
   ```
   XREADGROUP GROUP diag-flush diag-flush-${pid} COUNT $BATCH_SIZE BLOCK 1000 STREAMS diag:queue >
   ```
   The `>` cursor means "only entries never delivered to any consumer in this group".
2. If Redis returns `null` (1 s timeout, no entries), `continue` — back to step 1.
3. Otherwise, for each `[streamKey, entries]` pair (only one because we read from a single stream):
   1. Call `flushBatch({ sql, redis, group: 'diag-flush', stream: 'diag:queue', entries })`.
   2. `flushBatch` walks `entries` and calls `parseEntry(fields)` on each. Valid rows go into `validRows`; the streamId is recorded in `ackIds` regardless.
   3. If `validRows.length > 0`, build one parameterised INSERT (placeholders + 10 args per row, casts: `::timestamptz`, `::uuid`, `::bigint`, `::jsonb`) and `await sql.unsafe(text, args)`. The INSERT ends with `ON CONFLICT (id, ts) DO NOTHING`.
   4. `await redis.xack('diag:queue', 'diag-flush', ...ackIds)`.

```text
Redis Stream `diag:queue`
        │
        ▼
XREADGROUP (BLOCK 1000ms, COUNT $BATCH_SIZE)
        │
        ▼
parseEntry(fields)  per entry  →  ParsedEntry | null
        │                            │
        │                            └─▶ null → log warn, still in ackIds
        ▼
[ParsedEntry, ...]
        │
        ▼
INSERT INTO diagnostic_events VALUES (...), (...), ... ON CONFLICT DO NOTHING
        │
        ▼
XACK diag:queue diag-flush <id1> <id2> ...
```

## Alternative flow — empty batch

If the entire batch fails to parse (every entry malformed), the INSERT step is skipped but every `streamId` is still `XACK`ed. This is intentional: malformed entries are unrecoverable and would otherwise pile up in `pending`, blocking the consumer.

## Error flow — Postgres rejects the INSERT

1. `sql.unsafe` rejects (e.g. constraint violation on `severity` CHECK, or pg restart).
2. The exception propagates out of `flushBatch`.
3. The main-loop `catch` logs `error` with `flush iteration failed`.
4. `await new Promise(r => setTimeout(r, 1000))` — back-off 1 s.
5. Loop iteration resumes. The previous `XACK` did not fire, so `XREADGROUP` redelivers the same batch on next call (because we used `>` and never acknowledged).
6. `ON CONFLICT (id, ts) DO NOTHING` makes the second insert idempotent if the first had partially landed; otherwise the whole batch retries.

## Error flow — Redis `XACK` rejects

Same retry semantics as the Postgres path. The INSERT may have committed but the `XACK` did not — the redelivery hits `ON CONFLICT` and is a no-op, then `XACK` is reissued.

## Error flow — malformed entry

Field-list missing one or more of `id`, `ts`, `component`, `severity`, `kind`, `message`:

1. `parseEntry` returns `null`.
2. `flushBatch` logs `warn` with `streamId` and the raw `fields`.
3. The `streamId` is still added to `ackIds` so the entry leaves the pending list.
4. The bad row is dropped permanently. There is no dead-letter queue; we accept the loss because the row was never well-formed in the first place. Operators can grep `docker logs worker-diag-flush | grep "malformed diag entry"` to inventory drops.

## Background — heartbeat

Independent of the main loop, `startHeartbeat({ redis, name: 'diag-flush', statusFn: () => 'ok' })` publishes `worker:heartbeat:diag-flush` every 5 s with a 30 s TTL. If the loop is wedged (e.g. a 30 s pg-statement-timeout), the heartbeat keeps writing — `statusFn` returns `'ok'` regardless. A truly dead worker stops writing and the key expires within 30 s.

## Shutdown — SIGINT / SIGTERM

1. Log `{sig} shutdown`.
2. Set `stopped = true` so the next iteration of the main loop exits cleanly.
3. Stop the heartbeat publisher.
4. If a batch is currently in flight, `await inflight` (errors swallowed so teardown still runs). The main loop tracks each iteration's `flushBatch` work in a module-local `inflight: Promise<void> | null`; this guarantees the active batch's `INSERT` + `XACK` complete before the clients close, so a SIGTERM mid-batch never races `XACK` against `redis.quit()`.
5. Wait up to 5 s for `sql.end({ timeout: 5 })` to drain remaining queries.
6. `redis.quit()` (best-effort, swallow errors).
7. `process.exit(0)`.

If the loop is currently inside a 1 s `BLOCK` `XREADGROUP` (no batch in flight, `inflight` is `null`), the `redis.quit()` aborts the call — the loop's catch logs the error once, then `stopped` is `true` so the while exits. Total shutdown time is bounded by the active batch (typically < 50 ms for an INSERT of ≤ 100 rows) plus the 5 s `sql.end` timeout.

## Crash recovery

If the process crashes (uncaught exception, OOM, host reboot):

1. Compose's `restart: unless-stopped` brings it back.
2. The new instance issues `XGROUP CREATE ... MKSTREAM`. The group already exists → `BUSYGROUP` is swallowed.
3. The new consumer name `diag-flush-${new_pid}` differs from the old one. Pending entries from the dead consumer remain claimed by `diag-flush-${old_pid}` and are NOT redelivered to the new consumer automatically.
4. After the cluster has been stable, the operator can reclaim them with `XAUTOCLAIM` if needed; otherwise they hang in `pending` until a sweep. **This is a known gap; Phase A2 may add a `XAUTOCLAIM` sweep on startup.**

## Interactions

| Component | Direction | Interaction |
|---|---|---|
| Redis (`diag:queue`) | in | `XREADGROUP > BLOCK 1000` |
| Redis (`diag:queue`) | out | `XACK` |
| Redis (heartbeat) | out | `SET worker:heartbeat:diag-flush ... EX 30` |
| Postgres (`diagnostic_events`) | out | batched `INSERT ... ON CONFLICT DO NOTHING` |
| API `/api/v1/health/workers` | indirect | reads the heartbeat key |
| `@squad/diag` (producer) | none direct | both sides talk to Redis only |
