# worker-log-ingest — Flows

## Startup

1. Read `DATABASE_URL`, `REDIS_URL` from environment; fatal-exit if missing.
2. Create `BridgeClient` (socket path from `BRIDGE_SOCKET` or `/run/panel-host-bridge.sock`).
3. Call `reconcile()` immediately.
4. Start `setInterval(reconcile, 15_000)`.
5. Start heartbeat (`worker:heartbeat:log-ingest`, every 5 s).

## Reconcile loop (every 15 s)

1. Query `servers JOIN server_settings` for all rows.
2. Build `wanted` set: servers with `status IN ('running', 'starting')`.
3. For each id in `wanted` not yet in `aborters` map → `attachTail(serverId, beaconPort)`.
4. For each id in `aborters` not in `wanted` → call the abort function, remove from map.

## Log tail (per server)

`tailContainerLogs()` calls `bridge.containerLogsFollow({ name: 'squad-{uuid}', tail: 100 })`:

1. Only `stream === 'stdout'` frames are processed; stderr is discarded.
2. Bytes are appended to a line buffer; newline-split lines are dispatched to `onLine`.
3. Byte and line rate are logged as `debug` every 60 s.
4. On bridge stream end or error: log `warn 'tail dropped → restart'`. The reconcile loop will reattach on the next tick.

## Event parsing and publishing

For each line:

1. `isBenignNoise(line)` → drop if true.
2. `parseLine(line)` → extract `category`, `message`, `ts`. Drop if prefix doesn't match.
3. `LogIngestor.handleMessage(category, message, ts)` → returns zero or more `EventEnvelope` objects.
4. For each envelope: `publish(redis, envelope)` — dedup check then `XADD`.

## Player-connect correlation

Squad emits two separate log lines for a player join:

1. `LogNet: Join succeeded: <name>` — sets `recentJoin = { name, ts }`.
2. (within 2500 ms) `LogRedpointEOS: … EOS:<id> … Steam:<id>` — if `recentJoin` is set and the age is within the window, emit `player.connected` with name + IDs, then clear `recentJoin`.

If the EOS line arrives more than 2500 ms after `Join succeeded`, the join is dropped. This is intentional to avoid spurious connections.

## Graceful shutdown (SIGTERM / SIGINT)

1. Stop heartbeat.
2. Clear reconcile interval.
3. Call all abort functions; clear `aborters` map.
4. `redis.quit()`.
5. `bridge.close()`.
6. `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| Bridge socket unavailable on start | `BridgeClient` queues the connection; reconnects automatically |
| `containerLogsFollow` stream ends | Log warn; next reconcile reattaches |
| `publish()` Redis error | Log error; event is lost (no retry) |
| Malformed log line | `parseLine` returns null; line is dropped silently |
| DB query failure in reconcile | Log error; skip this cycle |
