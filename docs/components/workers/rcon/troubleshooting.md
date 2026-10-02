# worker-rcon — Troubleshooting

## AUTH fails immediately after server start

**Symptom:** `rcon:status:{id}` stays `connecting`; logs show `rcon auth rejected` or `rcon connect timeout`.

**Likely cause:** Squad binds its RCON listener several seconds after the process starts. The status-reconciler may flip the DB row to `running` before RCON is ready.

**Fix:** The exponential backoff (1 s → 60 s) covers this automatically. Confirm the worker is in the retry loop by checking `rcon:status:{id}` for `state: "connecting"` and a rising `backoffMs`.

## AUTH appears to hang

**Symptom:** Auth timeout after 5 s on every attempt.

**Likely cause:** Squad's quirk — it sends an empty `SERVERDATA_RESPONSE_VALUE` (type 0, id 0) before the real `SERVERDATA_AUTH_RESPONSE`. The client ignores the dummy packet and waits for the real one. If Squad changed this sequence, `client.ts:authenticate` must be updated.

**Diagnostic:**

```bash
docker compose logs worker-rcon --since 5m | grep 'rcon auth'
```

## `rcon:status:{id}` is absent but the server is running

**Symptom:** API returns `{ state: "not_polled" }`, panel shows "— (сервер не запущен)" ("— (server is not running)").

**Possible causes:**

1. Worker crashed — check `worker:heartbeat:rcon` exists in Redis.
2. DB `servers.status` is not `running` or `starting` — the reconcile loop won't add the server as a target.
3. TTL expired (300 s) without a successful poll — look for `ListPlayers poll failed` in logs.

## `consecutivePollFails` reaches 3, worker reconnects in a loop

**Symptom:** Logs show repeated `tearing down rcon client after 3 consecutive poll failures` followed by reconnect.

**Likely cause:** Squad server is overloaded or `exec()` times out (10 s). Check Squad container CPU and the game's server tick rate in `rcon:status:{id}.tickrate_rt`.

## Player rows not appearing in Postgres

**Symptom:** `SELECT count(*) FROM players` stays at 0 after a server has been running for minutes.

**Diagnostic:** Check that `rcon:status:{id}.state = "connected"` and `last_poll_at` is recent. Then confirm `DATABASE_URL` in the worker container matches the running Postgres instance.

## `APP_ENCRYPTION_KEY` must decode to 32 bytes

**Symptom:** Worker exits immediately with `APP_ENCRYPTION_KEY must decode to 32 bytes`.

**Fix:** Re-generate the key: `openssl rand -base64 32`. Update the `.env` file and restart the worker.

## Useful commands

```bash
# Check RCON status for a server
redis-cli GET rcon:status:<uuid>

# Worker heartbeat
redis-cli GET worker:heartbeat:rcon

# Tail worker logs
docker compose logs worker-rcon -f --since 2m

# Recent events from a server
redis-cli XREVRANGE events:server:<uuid> + - COUNT 10
```

## The roster shows no players but the server is full

**Symptom:** `rcon:status:{id}` has `roster_parse_error` set, `player_count` / `squad_count` are `null`, and worker-rcon logs `ListPlayers reply has rows but none parsed` (or `ListSquads ...`).

**Cause:** a Squad update changed the `ListPlayers` / `ListSquads` layout and the strict parsers in `parse-list-players.ts` / `parse-list-squads.ts` no longer match ([#126](https://github.com/seregatipich/squad-admin-panel/issues/126)). The warning's `sample` shows the new layout with every value masked, so the new field names are visible without any player data.

**Fix:** extend the regex in the parser to accept the new fields (keep the old layout accepted) and add the sample as a fixture. Until then the panel keeps the last good roster and does not close sessions or emit squad events.

## `a2s:status` says the query is unavailable

**Symptom:** `a2s:status:{id}` is `{ "visible": null, "reason": "timeout", ... }` while `rcon:status:{id}.state` is `connected`.

**Cause:** nothing answered on the UDP query port. RCON works on a different socket, so the server is up; the game process may not be servicing its query socket (#127), or a firewall drops UDP. `reason: refused_address` means the host resolved to a loopback, link-local, unspecified or non-allowlisted private address. The panel shows this as a warning on the query-port row with the time of the last answer, not as an offline server.

**Diagnostic:** `ss -ulnp | grep <query port>` on the game host: a `Recv-Q` that is full and never drains means the process does not read the socket.
