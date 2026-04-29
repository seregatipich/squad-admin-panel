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

## Background — journald forwarder

Independent of the consumer loop, `startJournaldForwarder({ redis, log })` runs as a side-process. Producer side: the Go bridge writes structured JSON lines to stderr via `handlers.DiagLog(...)` (see [`docs/components/bridge/api.md`](../../bridge/api.md#diagnostic-events-journald)), captured by systemd into the journal.

```
panel-host-bridge stderr (DIAG_EVENT JSON line)
        │
        ▼
systemd-journald (per-unit log buffer)
        │
        ▼
worker-diag-flush spawns:
   journalctl -u panel-host-bridge -o json -f --since "30s ago"
        │
        ▼  stdout (one journald JSON record per line)
parseJournaldLine(line)
        │  unwraps MESSAGE → inner JSON → checks DIAG_EVENT === '1'
        ▼
handleJournaldLine → redis.xadd diag:queue MAXLEN ~ 100000 ...
        │
        ▼
Same diag:queue stream consumed by the main XREADGROUP loop above.
```

Tunables (env, all optional):

- `DIAG_JOURNALD_FORWARD=false` disables the subprocess entirely — useful for local dev where the bridge isn't running.
- `DIAG_JOURNALD_UNIT` overrides the unit name (default `panel-host-bridge`).
- `DIAG_JOURNALD_SINCE` overrides the `--since` window (default `30s ago`).

Failure modes:

- **`journalctl` binary missing**: `child.on('error')` logs `error: journalctl spawn failed` once. The forwarder is dead but the main consumer loop and the heartbeat keep running. The container will keep restarting only if `journalctl` is the *first* failure — by design we don't crash on it because the consumer half is the worker's primary job.
- **Per-line parse failure** (malformed journald JSON, MESSAGE that isn't our DIAG_EVENT shape): `parseJournaldLine` returns `null` and the line is silently skipped. No log spam — non-DIAG_EVENT journal entries are the common case.
- **`redis.xadd` rejects** (Redis disconnected, network blip): `handleJournaldLine` rejects, the surrounding `.catch(...)` logs `warn: diag journald-forward failed`. The next line resumes normally because each call is independent. There is no replay — losing a few lines during a Redis outage is acceptable since both halves of the panel can independently observe the bridge.
- **Subprocess exit** (host journald restarts, container OOM-killed-but-recovered): `child.on('exit')` logs `info: journalctl exited`. The subprocess does NOT auto-restart inside this worker; compose's `restart: unless-stopped` catches container-level deaths but a journalctl exit alone does not crash the worker. **This is a deliberate trade-off** — restart-loop logic is deferred to Phase A3 if it becomes a real issue.
- **Shutdown**: `shutdown(sig)` calls `journald?.stop()` which sends `SIGTERM` to the child before awaiting the in-flight batch. The child usually exits in <100 ms.

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
| Redis (`diag:queue`) | out | `XADD` from journald forwarder (one per `DIAG_EVENT` line on `panel-host-bridge` journal) |
| Redis (heartbeat) | out | `SET worker:heartbeat:diag-flush ... EX 30` |
| Postgres (`diagnostic_events`) | out | batched `INSERT ... ON CONFLICT DO NOTHING` |
| systemd-journald (`panel-host-bridge.service`) | in | `journalctl -u panel-host-bridge -o json -f --since "30s ago"` subprocess stdout |
| API `/api/v1/health/workers` | indirect | reads the heartbeat key |
| `@squad/diag` (producer) | none direct | both sides talk to Redis only |
| `apps/bridge` (`handlers.DiagLog`) | indirect | bridge writes JSON lines to stderr; journald captures; the forwarder reads + replays into `diag:queue` |
