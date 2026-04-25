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
   - If no `PerServerSupervisor` exists for this id → create one and call `supervisor.start()`.
   - If one exists → update the target reference (password rotation support).
4. For each existing supervisor whose server is no longer in the wanted set → call `supervisor.stop()` and remove it.

## Per-server connection loop

Each `PerServerSupervisor` runs an infinite `connectLoop`:

1. Write `rcon:status:{id}` = `{ state: "connecting" }`.
2. Open TCP to `host:port` (5 s connect timeout).
3. Send `SERVERDATA_AUTH` packet; wait for the Squad two-packet AUTH response sequence (empty `SERVERDATA_RESPONSE_VALUE` with id 0, then `SERVERDATA_AUTH_RESPONSE` with the request id).
4. On success: write `state: "connected"`, emit `rcon.connected`, start poll timer.
5. On failure: log warn, write `state: "connecting"`, sleep with exponential backoff (initial 1 s, max 60 s), retry.

## Poll cycle (every 30 s)

1. `exec('ListPlayers')` → `parseListPlayers()` → `upsertPlayers()`.
2. `exec('ShowServerInfo')` → `parseServerInfo()`.
3. Emit `rcon.players_polled` envelope to `events:server:{id}`.
4. Write `rcon:status:{id}` = `{ state: "connected", player_count, last_poll_at, tickrate_rt, ... }`.
5. On 3 consecutive poll failures: close client, trigger reconnect loop.

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
