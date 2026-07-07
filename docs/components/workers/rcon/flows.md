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
4. On success: write `state: "connected"`, emit `rcon.connected` envelope to `events:server:{id}`, fire-and-forget diag emit `rcon.connected` (severity `info`, payload `{ host, port }`), start poll timer.
5. On failure:
   - If the error message is `rcon auth rejected` (id=-1) or `rcon auth timeout` (5 s), fire-and-forget diag emit `rcon.auth_failed` (severity `error`, payload `{ host, port, err }`).
   - Always emit the `rcon.disconnected` envelope to `events:server:{id}` and fire-and-forget diag emit `rcon.disconnected` (severity `warn`, payload `{ host, port, reason }`) where `reason` is the disconnect cause (`remote-close`, `explicit-close`, the auth error string, or `unknown`).
   - Write `state: "connecting"` with `reason: "reconnect-backoff"`, fire-and-forget diag emit `rcon.reconnect_attempt` (severity `warn`, payload `{ host, port, backoffMs }`), then sleep with exponential backoff (initial 1 s, max 60 s) and retry.

## Poll cycle (every 30 s)

1. `exec('ListPlayers')` → `parseListPlayers()` → `upsertPlayers()`.
2. `exec('ListSquads')` → `parseListSquads()` → write `rcon:squads:{id}`.
3. `exec('ShowServerInfo')` → `parseServerInfo()`.
4. `exec('ShowNextMap')` → `parseShowNextMap()`.
5. Emit `rcon.players_polled` envelope to `events:server:{id}`.
6. Write `rcon:status:{id}` = `{ state: "connected", player_count, squad_count, last_poll_at, tickrate_rt, next_layer, ... }`.
7. On 3 consecutive poll failures: close client, trigger reconnect loop.

## Keepalive (every 90 s via RconClient)

`RconClient.keepalive()` fires `ShowServerInfo` independently of the supervisor poll. This prevents the Squad RCON socket from silently dying due to inactivity.

## Graceful shutdown (SIGTERM / SIGINT)

1. Stop heartbeat.
2. Clear reconcile interval.
3. Call `supervisor.stop()` for all targets → closes each TCP socket, rejects pending commands.
4. `redis.quit()`.
5. `process.exit(0)`.

## Error handling

| Scenario | Behaviour |
|---|---|
| TCP connect timeout (5 s) | Reconnect with backoff |
| AUTH rejected (id=-1) | Reconnect with backoff |
| `exec()` timeout (10 s) | `consecutivePollFails++`; after 3 → reconnect |
| Redis `XADD` failure | Log warn, continue |
| DB query failure in reconcile | Log error, skip this cycle |
| Credential decrypt failure | Log error, skip this server |
