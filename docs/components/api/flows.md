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

[`lib/first-owner.ts`](../../../apps/api/src/lib/first-owner.ts) — called once during the Steam OAuth callback when no owner exists yet.

```
claimFirstOwner(db, bridge, steamId64):

  1. bridge.fileRead('/var/lib/squad-panel/.first-owner-claimed')
        success → return 'already_claimed'   (fast path; avoids transaction)
        ENOENT/error → continue

  2. db.transaction:
        SELECT pg_advisory_xact_lock(hashtext('first_owner'))
                    — serialises concurrent Steam callbacks on the same Postgres connection

        org = SELECT * FROM organizations LIMIT 1
        if none → throw Error('no_organization_yet')

        if org.settings.first_owner_claimed === true → return 'already_claimed'

        ownerRole = SELECT * FROM roles WHERE org_id = org.id AND name = 'Owner' LIMIT 1
        if none → return 'no_owner_role'

        INSERT INTO players (steam_id64, canonical_name, …) ON CONFLICT DO NOTHING
        INSERT INTO player_role_assignments (steam_id64, role_id, assigned_by=null) ON CONFLICT DO NOTHING
        INSERT INTO organization_members (steam_id64, org_id, primary_role_id) ON CONFLICT DO NOTHING
        UPDATE organizations SET settings = { …, first_owner_claimed: true }

        bridge.fileAtomicWrite('/var/lib/squad-panel/.first-owner-claimed', {steam_id64, claimed_at})
                    — LAST operation; failure rolls back entire transaction
  3. return 'claimed'
```

If `fileAtomicWrite` throws, the whole transaction rolls back — no partial state, no DB flag set, trick stays armed for the next callback attempt.

## Audit log

Every authed mutation route runs through [`plugins/audit.ts`](../../../apps/api/src/plugins/audit.ts):

1. Compute canonical JSON of the audit row (without `id`/`row_hash`).
2. `INSERT INTO audit_log (...)`. The DB trigger acquires `pg_advisory_xact_lock(audit_log_lock)`, reads the previous `row_hash`, computes `sha256(prev_hash || canonical_json)`, and writes `row_hash` + `prev_hash`.
3. `BEFORE UPDATE OR DELETE` triggers raise `audit_log is append-only`.

`pnpm verify:audit-chain` walks the table in `id` order and recomputes hashes; it exits non-zero on the first mismatch.
