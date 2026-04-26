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

## Server soft-delete + backup

Orchestrator: [`apps/api/src/lib/server-delete.ts`](../../../apps/api/src/lib/server-delete.ts). Route: `DELETE /api/v1/servers/:id` in [`apps/api/src/routes/servers.ts`](../../../apps/api/src/routes/servers.ts).

```
DELETE /api/v1/servers/:id
  ↓ 404 if servers.deleted_at IS NOT NULL (idempotent)
  ↓
softDeleteServer(ctx, serverId):
  Phase 1 — backup configs (THROWS on total failure)
    for file in ALLOWED_CONFIG_FILES:
      bridge.fileRead({path: "${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/${file}"})
        success → push {filename, content, sha256} to `backed`
        failure → log warn, skip the file
    if backed.length === 0:
      throw "no config files could be backed up"   ← server stays alive, 500 to client
    db.transaction:
      INSERT config_versions × backed.length VALUES (
        server_id=id, filename, content, sha256,
        author_steam_id64=actor, author_label="steam:<id>" or "system",
        message="deletion-backup-marker <iso>"
      )
      backup_marker_id = first inserted row's id

  Phase 2 — container (best-effort, errors recorded)
    bridge.containerStop({name: "squad-${id}", timeout_sec: 30})    ← swallow not_found
    bridge.containerRm({name: "squad-${id}"})                       ← not_found counts as success
    container_removed = true on success or not_found

  Phase 3 — disk (best-effort)
    bridge.directoryDelete({path: "${PANEL_CONFIGS_ROOT}/${id}"})   ← exact-root, no children
    bridge.directoryDelete({path: "${PANEL_SAVED_ROOT}/${id}"})

  Phase 4 — firewall (best-effort, per-port)
    settings = SELECT * FROM server_settings WHERE server_id = id
    for port in [game_port:udp, query_port:udp, beacon_port:udp, rcon_port:tcp]:
      bridge.ufwRule({action: 'remove', port, proto, comment: "squad-{kind}-${id8}"})
      ufw_rules_removed++ on success

  Phase 5 — soft-delete UPDATE (single row)
    UPDATE servers
       SET deleted_at = now(),
           deleted_by_steam_id64 = actor,
           deletion_backup_marker_id = backup_marker_id,
           updatedAt = now()
     WHERE id = ? AND deleted_at IS NULL          ← partial-unique-safe

  return DeleteResult { backup_marker_id, files_backed_up, files_attempted,
                        container_removed, configs_dir_removed, saved_dir_removed,
                        ufw_rules_removed, errors[] }

route layer:
  Phase 6 — audit
    auditPlugin writes audit_log row with action='server.delete',
    target='server', context=DeleteResult JSON.

  Phase 7 — live event
    app.liveBus.publish({type: 'server.deleted', ts, data: {server_id, deleted_at, by}})
    → in-process WS subscribers see it immediately,
    → Redis PUBLISH live-bus replicates to other API instances.
```

Failure handling per phase: phase 1 throws → 500, server stays alive. Phases 2-4 errors are collected in `result.errors[]` and the delete still completes (operator inspects `audit_log.context.errors` and cleans up by hand if needed). Phase 5 always runs because phases 2-4 do not throw; the row gets `deleted_at` even when the container or files survive.

## Server restore (archive → new server)

Three-step orchestrator (no single endpoint glues them together — UI drives the wizard). Code: [`apps/api/src/routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts) and [`apps/api/src/lib/server-restore.ts`](../../../apps/api/src/lib/server-restore.ts).

```
1. POST /api/v1/servers/archive/:archiveId/restore  body={slug, display_name?}
     → SELECT * FROM servers WHERE id=archiveId AND deleted_at IS NOT NULL
     → 404 if missing
     → SELECT 1 FROM servers WHERE slug=$slug AND deleted_at IS NULL
     → 409 slug_in_use if found (servers_slug_active_key partial-unique)
     → INSERT INTO servers (id=uuidv7(), display_name, slug, description, status='pending',
                           runtime='container', tags=archive.tags, timezone=archive.timezone)
     → liveBus.publish({type: 'server.restored', data: {old_server_id, new_server_id}})
     → 201 { id: newId, archive_id, slug, display_name, status, next_steps[] }

2. POST /api/v1/servers/:newId/install
     → existing install pipeline (depot check → seedConfigs writes 19 default cfg →
       19 baseline config_versions rows → ufw_rule add ×4 → container_run)

3. POST /api/v1/servers/:newId/restore-configs  body={from_archive_id}
     → SELECT * FROM servers WHERE id=newId AND deleted_at IS NULL  → 404 if missing
     → SELECT * FROM servers WHERE id=from_archive_id AND deleted_at IS NOT NULL
     → 404 archive_not_found if missing
     → SELECT * FROM config_versions
        WHERE server_id = from_archive_id AND message LIKE 'deletion-backup-marker%'
        ORDER BY created_at ASC
     → byFile = first occurrence wins per filename (asc order)
     → for filename in ALLOWED_CONFIG_FILES:
         if filename === 'Rcon.cfg': skip (preserve new RCON password)
         backup = byFile.get(filename); if missing: record files_missing
         bridge.fileAtomicWrite({path: "${PANEL_CONFIGS_ROOT}/${newId}/ServerConfig/${filename}",
                                content: backup.content})
         INSERT config_versions VALUES (server_id=newId, filename, content, sha256,
                                        author=actor,
                                        message="restored from server <archiveId> backup <iso>")
     → returns RestoreConfigsResult { files_restored, files_skipped, files_missing,
                                      config_version_ids[], errors[] }

4. POST /api/v1/servers/:newId/start    (existing route — boots Squad with restored configs)
```

Audit row at step 1 (`server.restore`), step 3 (`server.restore_configs`), and the existing audit on step 2/4. `Rcon.cfg` skip is intentional: backing up the old password works (it's just text), but copying it to the new server would defeat the rotation that happened during install.

## Status reconciler

[`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts) — fires once on `onReady` and then every `RECONCILE_INTERVAL_MS` (4 s):

```
on ready: tick() once immediately
every 4 s: tick()

tick():
  rows = SELECT id, status FROM servers
         WHERE status IN TRANSIENT_STATES AND deleted_at IS NULL
  prune bridgeFailures map: drop any id no longer in the tick set
  for row in rows:
    try:
      res = bridge.containerInspect({name: "squad-${id}"})
      bridgeFailures.delete(id)            ← reset on first success
    catch err:
      next = (bridgeFailures.get(id) ?? 0) + 1
      bridgeFailures.set(id, next)
      log.debug at 1, log.warn at 5, 30, 60, 120, ...   ← escalating cadence
      continue                              ← do NOT modify DB
    mapped = mapState(res.state, res.running)
    if !mapped.known:
      log.warn 'unknown docker state' (DB stays as-is — surfaces as stuck)
      continue
    if mapped.status !== row.status:
      UPDATE servers SET status=mapped.status, container_id, updated_at WHERE id=?
      liveBus.publish({type:'server.status', source:'reconciler'})
```

`mapState(dockerState, running)` — single source of truth for the docker→DB mapping:

| Inspect | DB status |
|---|---|
| `running=true` (any state string) | `running` |
| `state='running'` | `running` |
| `state='created'` / `'restarting'` | `starting` |
| `state='paused'` / `'removing'` | `stopping` |
| `state='exited'` / `'dead'` / `'not_found'` | `stopped` |
| anything else | `{status: null, known: false}` — DB untouched, warn |

### TRANSIENT_STATES (rows the reconciler watches)
`starting`, `stopping`, `running`, `stopped`, `ready`, `installing`, `failed`. Even terminal states like `running` and `stopped` are watched so an externally restarted/crashed container is reflected back into the DB.

### STUCK_CANDIDATE_STATES (rows the health endpoint flags)
`starting`, `stopping`, `installing`. A row in one of these states with `updated_at` older than `STUCK_AFTER_MS` (90 s) appears in `GET /api/v1/health/reconciler` `stuck_servers[]`. `running`/`stopped` are NOT stuck candidates — they are valid steady states.

### Escape hatches when a row is stuck
1. `POST /api/v1/servers/:id/reconcile` — drives one immediate `container_inspect` for the given server. Returns `{previous_status, new_status, changed, inspected_state, inspected_running}`. 502 if the bridge throws (ops should investigate the bridge then retry).
2. `GET /api/v1/health/reconciler` — exposes `last_tick_at`, `consecutive_tick_errors`, `stuck_servers[]`, `bridge_failures_by_server`. The derived `healthy` flag goes false if the loop hasn't ticked in 12 s, has any consecutive tick errors, or any stuck rows.

### Eager status writes on user actions
`POST /api/v1/servers/:id/stop` writes `status='stopping'` to the DB **before** the RCON broadcast + 15 s wait + `container_stop`, then publishes `server.status` to live-bus. This means:
- A crash mid-stop leaves a `stopping` row that the next reconciler tick can resolve to `stopped` (or back to `running` if Docker says so).
- The UI updates instantly instead of after ~75 s of slow bridge calls.

`POST /api/v1/servers/:id/start` keeps the existing pattern — DB→`starting` is set after the bridge call returns, since `containerRun`/`containerStart` are short.

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
