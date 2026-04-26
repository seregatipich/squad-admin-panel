# `api` — flows

## Install WebSocket

```
client → POST /api/v1/servers (name, ports)         → 201 {id, status:'pending'}
client → WS /api/v1/servers/:id/install
                                                   ┌─ check depot volume:
                                                   │  bridge.container_inspect squad-depot
                                                   ├─ if missing/empty:
                                                   │   bridge.depot_update (≈25 min, streamed)
                                                   ├─ seedConfigs():
                                                   │   read 19 .cfg from depot _data
                                                   │   write into /var/lib/squad-panel/configs/{uuid}/ServerConfig/
                                                   │   patch Rcon.cfg (password) + Server.cfg (display name)
                                                   │   INSERT config_versions × 19 (baseline)
                                                   ├─ ufw_rule add × 4 (game/query/beacon/RCON)
                                                   ├─ bridge.container_run with structured spec
                                                   └─ resolve WS with {ok:true}
status-reconciler (every 4 s) flips servers.status → 'running'
```

The WS uses `app.makeBridgeClient()` (per-socket bridge connection) so a long-running `depot_update` does not starve sibling callers using `app.bridge`.

## Status reconciler

[`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts):

```
every 4 s:
  for srv in SELECT id, container_name FROM servers WHERE status NOT IN ('pending','failed'):
    inspect = bridge.container_inspect(container_name)
    desired = mapInspectToStatus(inspect)
    if desired !== srv.status:
      UPDATE servers SET status = desired
      audit row (action: 'server.status.reconciled')
      publish event to events:server:{id}
```

`mapInspectToStatus`:

| Docker state | DB status |
|---|---|
| `running` | `running` |
| `created` / `restarting` | `starting` |
| `exited (0)` | `stopped` |
| `exited (≠0)` | `crashed` |
| missing | unchanged (assume mid-creation) |

## Worker heartbeat aggregation

Each worker calls [`packages/shared-config/src/heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts):

```ts
SET worker:heartbeat:rcon "<json>" EX 30
```

`/api/v1/health/workers` reads the keys, computes `age = now - last_seen`, returns:

```json
{
  "workers": [
    { "name": "rcon", "alive": true, "age_ms": 4200, "details": {...} },
    { "name": "log-ingest", "alive": false, "age_ms": null }
  ]
}
```

## Bridge heartbeat

[`plugins/bridge-heartbeat.ts`](../../../apps/api/src/plugins/bridge-heartbeat.ts) starts a 5 s `setInterval` once the app is `onReady`. Each tick:

```
let inFlight = false
let lastWasUp = true
let lastDownAt = null
let stopped = false      // flipped by onClose; start() refuses to schedule again

every 5 s:
  if inFlight: skip                       // overlap guard for slow pings
  inFlight = true
  try:
    await bridge.ping()
    if was down before:
      info `recovered after <Xs>`         // transition log
    else:
      debug `alive rtt=<ms>`
    lastWasUp = true
  except err:
    if was up before:
      warn `down: <message>`              // transition log; lastDownAt = now
    else:
      debug `still down`                  // no warn flapping on every retry
    lastWasUp = false
  finally:
    inFlight = false
```

`tickOnce` is exposed on `app.bridgeHeartbeat` so tests can step the loop manually without waiting on the timer.

## Per-RPC bridge logging

`packages/bridge-client/src/client.ts` wraps the private dispatcher (`call`) so every RPC emits three structured log records via `onLog` — `rpc <method> start`, `rpc <method> <ms>ms ok`, `rpc <method> <ms>ms err: <message>`. The api wires `onLog` to `app.log` (`src: 'bridge'`), so all RPCs land in `panel:logs` for the connector-logs UI without any per-method instrumentation.

## Live log WebSocket

`server-logs.ts` uses `app.makeBridgeClient()`, NOT the shared `app.bridge`. The shared instance was starving sibling calls when long log-follows held the multiplex.

```
ui WS connect →
  api: const client = app.makeBridgeClient()
       client.stream('container_logs_follow', { name, since: '2m' })
  forward each chunk as a WS frame
ui WS close →
  client.close()    ← critical: tears down the bridge subprocess on the host
```

## First-owner claim

[`lib/first-owner.ts`](../../../apps/api/src/lib/first-owner.ts) — called once during the Steam OAuth callback when no owner exists yet. DB anchor is `panel_meta.first_owner_claimed` (singleton row, id=1, created by migration 0009).

```
claimFirstOwner(db, bridge, steamId64):

  1. bridge.fileRead('/var/lib/squad-panel/.first-owner-claimed')
        success → return 'already_claimed'   (fast path; avoids transaction)
        ENOENT/error → continue

  2. db.transaction:
        SELECT pg_advisory_xact_lock(hashtext('panel_first_owner'))
                    — serialises concurrent Steam callbacks on the same Postgres connection

        meta = SELECT * FROM panel_meta WHERE id = 1 LIMIT 1
        if meta.first_owner_claimed === true → return 'already_claimed'

        ownerRole = SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true LIMIT 1
        if none → return 'no_owner_role'

        ownerExists = SELECT steam_id64 FROM players WHERE role_id = ownerRole.id LIMIT 1
        if exists → UPDATE panel_meta SET first_owner_claimed = true; return 'already_claimed'

        UPDATE players SET role_id = ownerRole.id WHERE steam_id64 = steamId64
        UPDATE panel_meta SET first_owner_claimed = true WHERE id = 1

  3. if result === 'claimed':
        bridge.fileAtomicWrite('/var/lib/squad-panel/.first-owner-claimed', {steam_id64, claimed_at})
                    — non-fatal if bridge write fails; DB is source of truth

  4. return result
```

`fileAtomicWrite` failure is non-fatal — the DB flag is already committed, so the sentinel is an optimistic fast-path shortcut only. The transaction itself does not embed the bridge call.

## Session lifecycle

[`lib/sessions.ts`](../../../apps/api/src/lib/sessions.ts) manages opaque session tokens keyed by SHA-256 hash.

### createSession

```
createSession(db, redis, { steamId64, ip, userAgent, ttlMs }):
  mint token = "s_{uuidv7}_{24 random bytes base64url}"
  tokenId = sha256(token)   ← stored in DB and Redis; token stays client-side only
  now = Date.now()
  expiresAt = now + ttlMs
  INSERT INTO sessions (id=tokenId, steam_id64, expires_at, last_activity_at=now, ip, userAgent)
  Redis SET session:{tokenId} {steamId64, expiresAt, lastActivityAt, ip, userAgent} EX 600
  return { token, session: SessionRecord }
```

BigInt serialisation: `steamId64` is stored as `String(bigint)` in Redis JSON and parsed back via `BigInt(string)` on read.

### resolveSession

```
resolveSession(db, redis, token):
  tokenId = sha256(token)
  hit = Redis GET session:{tokenId}
  if hit:
    if hit.expiresAt < now → revokeSession(); return null
    return hit as SessionRecord
  rows = SELECT * FROM sessions WHERE id=tokenId AND expires_at > now LIMIT 1
  if none → return null
  Redis SET session:{tokenId} … EX 600   ← warm cache for next call
  return SessionRecord
```

### touchSession (sliding TTL)

```
touchSession({ sessionId, redis, now, ttlSeconds, throttleSeconds, updateDb }):
  ok = Redis SET session-touch:{sessionId} 1 EX throttleSeconds NX
  if ok !== 'OK' → return false   ← within throttle window; skip DB write
  newExpiresAt = now + ttlSeconds * 1000
  updateDb(newExpiresAt, now)     ← caller provides the Drizzle UPDATE
  return true
```

Callers supply `updateDb` so `touchSession` stays DB-agnostic and unit-testable without a real Postgres connection.

### revokeSession / revokeAllForPlayer

```
revokeSession(db, redis, tokenId):
  DELETE FROM sessions WHERE id = tokenId
  Redis DEL session:{tokenId}

revokeAllForPlayer(db, redis, steamId64):
  rows = SELECT id FROM sessions WHERE steam_id64 = steamId64
  DELETE FROM sessions WHERE steam_id64 = steamId64
  Redis DEL session:{id} for each row
```

## Audit log

Every authed mutation route runs through [`plugins/audit.ts`](../../../apps/api/src/plugins/audit.ts):

1. Compute canonical JSON of the audit row (without `id`/`row_hash`).
2. `INSERT INTO audit_log (...)`. The DB trigger acquires `pg_advisory_xact_lock(audit_log_lock)`, reads the previous `row_hash`, computes `sha256(prev_hash || canonical_json)`, and writes `row_hash` + `prev_hash`.
3. `BEFORE UPDATE OR DELETE` triggers raise `audit_log is append-only`.

`pnpm verify:audit-chain` walks the table in `id` order and recomputes hashes; it exits non-zero on the first mismatch.
