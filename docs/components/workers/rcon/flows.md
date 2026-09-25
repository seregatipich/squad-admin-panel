# worker-rcon — Flows

## Startup

1. Read `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY` from environment; fatal-exit if missing.
2. Connect to Postgres and Redis.
3. Call `reconcile()` immediately to open connections to all currently `starting`/`running` servers.
4. Start `setInterval(reconcile, 15_000)`.
5. Start heartbeat (`worker:heartbeat:rcon`, every 5 s).

## Reconcile loop (every 15 s)

1. `SELECT id, status, rcon_host, rcon_port, rcon_password_encrypted FROM servers JOIN server_credentials JOIN server_settings`.
2. Decrypt each `rcon_password_encrypted` blob with AES-256-GCM.
3. For each server with `status IN ('starting', 'running')`:
   - If no `PerServerSupervisor` exists for this id → create one, push to `added`, and call `supervisor.start()`.
   - If one exists → update the target reference (password rotation support).
4. For each existing supervisor whose server is no longer in the wanted set → call `supervisor.stop()`, push to `removed`, and remove it from the map.
5. If `added.length || removed.length` and a `Diag` was injected, fire-and-forget emit `rcon.targets.changed` with `{ added, removed, total }`. No emit when the set is unchanged across a tick.

## Per-server connection loop

Each `PerServerSupervisor` runs an infinite `connectLoop`:

1. Write `rcon:status:{id}` = `{ state: "connecting" }`.
2. Open TCP to `host:port` (5 s connect timeout).
3. Send `SERVERDATA_AUTH` packet; wait for the Squad two-packet AUTH response sequence (empty `SERVERDATA_RESPONSE_VALUE` with id 0, then `SERVERDATA_AUTH_RESPONSE` with the request id).
4. On success: write `state: "connected"`, emit `rcon.connected` envelope to `events:server:{id}`, fire-and-forget diag emit `rcon.connected` (severity `info`, payload `{ host, port }`), start the per-server command queue consumer, then start poll timer.
5. On failure:
   - If the error message is `rcon auth rejected` (id=-1) or `rcon auth timeout` (5 s), fire-and-forget diag emit `rcon.auth_failed` (severity `error`, payload `{ host, port, err }`).
   - Always emit the `rcon.disconnected` envelope to `events:server:{id}` and fire-and-forget diag emit `rcon.disconnected` (severity `warn`, payload `{ host, port, reason }`) where `reason` is the disconnect cause (`remote-close`, `explicit-close`, the auth error string, or `unknown`).
   - Write `state: "connecting"` with `reason: "reconnect-backoff"`, fire-and-forget diag emit `rcon.reconnect_attempt` (severity `warn`, payload `{ host, port, backoffMs }`), then sleep with exponential backoff (initial 1 s, max 60 s) and retry.

## Live refresh (roster every 2 s, server info every 5 s, hints at once)

The panel's live views are fed by two light, RCON-only refreshes that never touch the database:

- **Roster** — `ListPlayers` + `ListSquads` → `rcon:roster:{id}`, `rcon:squads:{id}`, the `rcon.roster` live-bus event, and `player_count`/`squad_count` in `rcon:status:{id}`.
- **Server info** — `ShowServerInfo` + `ShowNextMap` → `current_map`, `next_level`, `next_layer`, `game_mode`, `public_queue`, `tickrate_rt` in `rcon:status:{id}`.

Each write merges into the fields the other paths already read, so a roster write never blanks the map. `rcon:status:changed` is published only when a rendered field or the state changes (tickrate and timestamps excluded), so frequent refreshes do not make every open panel refetch.

Both run once right after connect, then on their timers, and out of band on a **refresh hint**:

1. worker-log-ingest parses `player.connected`, `player.disconnected`, `match.started` or `match.ended` from the live log.
2. It `PUBLISH`es `{server_id, scopes, reason}` on `rcon:refresh` (`roster` for joins/leaves, `roster` + `info` for match boundaries).
3. worker-rcon's subscriber routes it to that server's supervisor; hints within 100 ms share one round-trip, and a busy client makes the hint wait instead of being dropped.
4. A roster hint is repeated once 1.5 s later, because Squad logs a join slightly before `ListPlayers` lists the player.

## Poll cycle (every 30 s)

1. `exec('ListPlayers')` → `parseListPlayers()` → `upsertPlayers()` → `accruePlayerKitTime()`.
2. `reconcilePlayerSessions()` — open a `player_sessions` row for every player in the roster that has none, close the rows of players who are no longer in it (PRES-1). Best-effort: a failure here is logged and does not count as a poll failure.
3. `exec('ListSquads')` → `parseListSquads()` → write `rcon:squads:{id}`.
4. `exec('ShowServerInfo')` → `parseServerInfo()`.
5. `exec('ShowNextMap')` → `parseShowNextMap()`.
6. Emit `rcon.players_polled` envelope to `events:server:{id}`.
7. Write `rcon:status:{id}` = `{ state: "connected", player_count, squad_count, last_poll_at, tickrate_rt, next_layer, ... }`.
8. On 3 consecutive poll failures: close client, trigger reconnect loop — which closes the server's open sessions at the last successful poll (`closeServerSessions()`), so the unobserved gap is not credited as play time.

## Operator command queue

The API writes P0 operator commands to `rcon:commands:{id}`. The worker consumes the stream only while the same server's RCON client is authenticated.

1. `RconCommandQueue.ensureGroup()` creates consumer group `worker-rcon:commands:v1` at stream id `0` with `MKSTREAM`, so commands already accepted into the stream are not skipped on first worker startup.
2. `XREADGROUP ... STREAMS rcon:commands:{id} >` receives up to 10 accepted commands.
3. The worker validates the request against the shared contract and builds one whitelisted RCON command:
   - `AdminBroadcast <message>`
   - `AdminEndMatch`
   - `AdminReloadServerConfig`
4. The command executes through `RconClient.exec()`, so it shares the same FIFO serialization as polling and keepalive commands.
5. The worker writes `rcon:command-result:{request_id}` with TTL 120 s and then `XACK`s the stream entry.
6. If validation or RCON execution fails, the worker writes `ok:false` result and still `XACK`s. Malformed entries without a `request_id` are only acknowledged.
7. Every 30 s the active consumer runs `XAUTOCLAIM` for entries idle longer than 60 s and replays them through the same validation/execution path. Before replay it checks `rcon:command-result:{request_id}`; if a result already exists, it only `XACK`s the claimed entry and does not execute RCON again.

If the API has already accepted a command into the stream and then times out waiting for the result, it does not retry through direct RCON. This avoids double side effects for `AdminEndMatch` and config reload.

The queue is at-least-once around the real RCON side effect: if the worker process dies after Squad accepts the command but before the worker writes the result key, a reclaimed entry may execute again. The result-key guard covers the safer crash window after result write but before `XACK`.

## Keepalive (every 90 s via RconClient)

`RconClient.keepalive()` fires `ShowServerInfo` independently of the supervisor poll. This prevents the Squad RCON socket from silently dying due to inactivity.

## Graceful shutdown (SIGTERM / SIGINT)

1. Stop heartbeat.
2. Clear reconcile interval.
3. Call `supervisor.stop()` for all targets → stops command consumers, closes each TCP socket, rejects pending commands.
4. `redis.quit()`.
5. `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| TCP connect timeout (5 s) | Reconnect with backoff |
| AUTH rejected (id=-1) | Reconnect with backoff |
| `exec()` timeout (10 s) | `consecutivePollFails++`; after 3 → reconnect |
| Redis `XADD` failure | Log warn, continue |
| Command stream read failure | Log warn, retry while the RCON session remains connected |
| Claimed pending command has an existing result key | `XACK` without another RCON execution |
| DB query failure in reconcile | Log error, skip this cycle |
| Credential decrypt failure | Log error, skip this server |
