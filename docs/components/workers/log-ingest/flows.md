# worker-log-ingest — Flows

## Startup

1. Read `DATABASE_URL`, `REDIS_URL` from environment; fatal-exit if missing.
2. Create `BridgeClient` (socket path from `BRIDGE_SOCKET` or `/run/panel-host-bridge/bridge.sock`).
3. Start raw log retention sweep: run once immediately, then every 1 hour via `bridge.squadLogRetentionSweep()`.
4. Call `reconcile()` immediately.
5. Start `setInterval(reconcile, 15_000)`.
6. Start heartbeat (`worker:heartbeat:log-ingest`, every 5 s).

## Reconcile loop (every 15 s)

1. Query `servers JOIN server_settings` for all rows.
2. Build `wanted` array: rows with `status IN ('running', 'starting')`, mapped to `{ serverId, beaconPort }`.
3. Call `TailManager.reconcile(wanted)`:
   - For each `serverId` in `wanted` not yet in the aborters map → invoke the factory (constructs `LogIngestor`, calls `tailContainerLogs`) and store the abort closure.
   - For each `serverId` in the aborters map not in `wanted` → call the abort closure, drop from the map.
   - If the call produced a non-empty `added` or `removed` list, fire-and-forget `diag.emit({ kind: 'tails.changed', payload: { added, removed, total } })`. Unchanged ticks emit nothing.

## Log tail (per server)

`tailContainerLogs()` calls `bridge.containerLogsFollow({ name: 'squad-{uuid}', tail: 100 })`:

1. Synchronously, before awaiting the bridge call, fire `onStarted()` — the worker translates this into a `tail.started` diag emit (severity `info`, payload `{ container }`).
2. Only `stream === 'stdout'` frames are processed; stderr is discarded.
3. Bytes are appended to a line buffer; newline-split lines are dispatched to `onLine`.
4. Byte and line rate are logged as `debug` every 60 s.
5. On bridge stream end or error: log `warn 'tail dropped → restart'`, then call `onStopped({ reason })` with `'stream-end'` or `'stream-error'` (with `error: errorMessage`). The reconcile loop will reattach on the next tick.
6. On explicit abort (`return () => { aborted = true; ... }`): the trailing `onStopped({ reason: 'aborted' })` fires from the IIFE's terminating branch.

The worker translates each `onStopped` into a `tail.stopped` diag emit carrying `{ container, reason, error? }`.

## Raw log retention sweep (startup + hourly)

`retention.ts` calls `bridge.squadLogRetentionSweep()` without params. The worker never receives a direct filesystem mount and never passes a path to the bridge.

The bridge-side policy is fixed:

1. Scan only `/var/lib/squad-panel/saved/{uuid}/SquadGame/Saved/Logs/`.
2. Delete only regular files matching `SquadGame*.log`.
3. Never delete exact `SquadGame.log`.
4. Delete only when `mtime + 10d < now`.
5. Continue after per-file/per-server errors and return counters.

On success the worker logs `deleted_count`, `deleted_bytes`, `error_count`, `servers_scanned`, `log_dirs_scanned`, `files_scanned`, `retention_days`, and `cutoff`, then emits:

```ts
{
  component: 'worker-log-ingest',
  kind: 'log.retention.sweep',
  severity: 'info' | 'warn',
  message: 'log retention sweep completed: deleted=<n>, bytes=<n>, errors=<n>',
  payload: { retention_days, cutoff, servers_scanned, log_dirs_scanned, files_scanned, deleted_count, deleted_bytes, error_count, errors }
}
```

`severity` is `warn` when `error_count > 0`. If the bridge call itself fails, the worker logs the failure and emits `log.retention.sweep_failed` with severity `error`; it does not exit. The scheduler uses an in-flight guard, so a slow sweep is not overlapped by the next hourly tick.

## Event parsing and publishing

For each line:

1. `isBenignNoise(line)` → drop if true (no diag emit).
2. `detectSquadFatal(line)` → if it matches `LogExit:`, `Fatal error:`, or `Assertion failed: … [File:… Line:…]`, fire-and-forget `diag.emit({ kind: 'squad.log.fatal', severity: 'fatal' })` with `{ ts, file, line, raw }`. Detection runs **before** the prefix parser so Assertion lines (which lack the timestamp prefix) still surface. No de-dupe — every matching line emits one diag event.
3. `parseLine(line)` → extract `category`, `message`, `ts`. If it returns null AND the line started with `[` AND `detectSquadFatal` did not match, fire-and-forget `diag.emit({ kind: 'parser_error', severity: 'warn' })` with `{ lineSample, regex: 'PREFIX', errorMessage }`. Otherwise drop silently.
4. `LogIngestor.handleMessage(category, message, ts)` → returns zero or more `EventEnvelope` objects. Wrapped in try/catch — any throw becomes a `parser_error` diag emit with `regex` set to the failing category name.
5. For each envelope: `publish(redis, envelope)` — dedup check then `XADD`.

## Squad fatal detection patterns

| Pattern | Source line shape | Captured groups |
|---|---|---|
| `SQUAD_LOG_EXIT` | `[<ts>][<tick>]LogExit: <msg>` | `ts`, `msg` |
| `SQUAD_FATAL_ERROR` | `[<ts>][<tick>]Fatal error: <msg>` | `ts`, `msg` |
| `SQUAD_ASSERTION_FAILED` | `... Assertion failed: <msg> [File:<file> Line: <line>]` | `msg`, `file`, `line` |

`file` / `line` are populated only for the assertion variant; the other two pass them as `null`.

## Player-connect correlation

Squad emits two separate log lines for a player join:

1. `LogNet: Join succeeded: <name>` — sets `recentJoin = { name, ts }`.
2. (within 2500 ms) `LogRedpointEOS: … EOS:<id> … Steam:<id>` — if `recentJoin` is set and the age is within the window, emit `player.connected` with name + IDs, then clear `recentJoin`.

If the EOS line arrives more than 2500 ms after `Join succeeded`, the join is dropped. This is intentional to avoid spurious connections.

## Graceful shutdown (SIGTERM / SIGINT)

1. Stop heartbeat.
2. Stop the hourly raw log retention interval.
3. Clear reconcile interval.
4. Call all abort functions; clear `aborters` map.
5. `redis.quit()`.
6. `bridge.close()`.
7. `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| Bridge socket unavailable on start | `BridgeClient` queues the connection; reconnects automatically |
| `containerLogsFollow` stream ends | Log warn; next reconcile reattaches |
| `publish()` Redis error | Log error; event is lost (no retry) |
| Raw log retention bridge failure | Log error, emit `log.retention.sweep_failed`, retry on next hourly tick |
| Malformed log line | `parseLine` returns null; line is dropped silently |
| DB query failure in reconcile | Log error; skip this cycle |
