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

**Symptom:** API returns `{ state: "not_polled" }`, panel shows "— (сервер не запущен)".

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
