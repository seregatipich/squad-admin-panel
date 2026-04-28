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

All three control routes write the DB row to its target transient state **before** invoking the bridge, then publish a `server.status` LiveEvent so the UI updates immediately and a process crash mid-call leaves the row in a state the reconciler can resolve.

| Route | DB before bridge call | Reconciler converges to |
|---|---|---|
| `POST /servers/:id/stop` | `stopping` | `stopped` (docker `exited`/`not_found`) or `running` (stop failed) |
| `POST /servers/:id/start` | `starting` | `running` (docker `running`) or `stopped` (start failed) |
| `POST /servers/:id/restart` | `starting` | same as start |

### Parallel inspects with a tick budget

The tick is bounded:

```
tick():
  rows = SELECT … WHERE status IN TRANSIENT_STATES
  raceWith TICK_BUDGET_MS (12 s):
    Promise.allSettled(rows.map(row => reconcileServer(row)))
  if budget exceeded:
    log.warn 'tick budget exceeded — some servers will retry next tick'
    tickState.lastBudgetExceeded = true
  failStaleInstalls()  ← watchdog
```

Each individual `containerInspect` is bounded by the BridgeClient's own 10 s timeout. With ~10 typical servers the tick finishes in ~50 ms; if all bridge calls hit the timeout simultaneously the budget kicks in and the next interval picks up where this one left off. The reconciler is therefore bounded by `max(per-call-timeout, TICK_BUDGET_MS)` even on unhealthy infrastructure.

### Stale-install watchdog

```
failStaleInstalls():
  cutoff = now - STALE_INSTALL_AFTER_MS  (30 min)
  for row in SELECT … WHERE status='installing' AND deleted_at IS NULL:
    if row.updated_at < cutoff:
      UPDATE servers SET status='failed', updated_at=now() WHERE id=row.id
      log.warn 'stale install flipped installing → failed'
      liveBus.publish({type:'server.status', source:'reconciler'})
      tickState.staleInstallsFailed++
```

This guards against the api process dying between `setStatus('installing')` and `setStatus('running')` in the install pipeline — without the watchdog, the row would sit in `installing` indefinitely. 30 min was picked to be safely above the typical depot_update wall-clock (~25 min on first install).

### Boot-time recovery

On `onReady` the plugin logs the count of transient rows it's about to converge:

```
{"level":30,"rows":3,"intervalMs":4000,"msg":"reconciler: ready — running initial recovery tick"}
```

A fresh api process announces what it inherited from the previous run; ops can grep for this line to confirm the reconciler started.

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

## Diagnostic emission

Plugin: [`apps/api/src/lib/diag.ts`](../../../apps/api/src/lib/diag.ts). Registered in [`server.ts`](../../../apps/api/src/server.ts) right after `redisPlugin` so the underlying ioredis connection is available.

```
registerDiag(app):
  diag = createDiag({ redis: app.redis, log: app.log })   ← from @squad/diag
  app.decorate('diag', diag)
  app.decorateRequest('diag', null)
  onRequest hook:
    requestId = req.id     ← Fastify-generated or x-request-id header
    req.diag = {
      emit(ev): app.diag.emit({ ...ev, requestId: ev.requestId ?? requestId })
    }
```

Route handlers reach the emitter via `req.diag.emit({...})`. The hook injects the request id on every emit unless the caller already supplied one. Each emit ends up as one `XADD` to the Redis Stream `diag:queue`; `worker-diag-flush` batches them into `diagnostic_events`. The full schema and event types live in [`@squad/diag` data model](../diag/data-model.md).

Stub-friendly for tests: replacing `app.diag.emit` with a capture function reroutes both `app.diag` calls and per-request emits, because the hook reads `app.diag.emit` at emit time rather than capturing the original closure.

### Lifecycle event sequences

The server-lifecycle routes emit a fixed set of events into `diag:queue`. Source files are the contract — this section documents intent + ordering, not payload schemas (those live in [`api.md` § "Lifecycle event kinds"](api.md)).

#### Install (POST /servers/:id/install)

Source: [`routes/server-install.ts`](../../../apps/api/src/routes/server-install.ts). The handler enqueues an async install IIFE and returns `202`-ish immediately; events fire over the lifetime of the install (typically 25–30 min on a cold depot, ~5 s on a warm depot).

```
api emits server.install.requested        ← before IIFE; payload.display_name + kind='install'
  ├─ ensureDepot(...)                     ← emits no diag itself; depot stream still goes to installProgress
  ├─ seedConfigs(...)
  │   └─ api emits server.install.depot_seed   ← payload.seededCount + durationMs
  ├─ ufw rules (×4: udp game/query/beacon, tcp rcon)
  │   └─ api emits server.install.ufw_rule     ← per port; severity='error' on failure
  ├─ bridge.containerRun(...)
  │   └─ api emits server.install.container_run ← payload.container_id + image
  ├─ DB: UPDATE servers SET status='running', container_id=...
  │   └─ api emits server.install.verify        ← payload.container_id
  └─ api emits server.install.done              ← payload.totalDurationMs
─────── on any throw above ───────
api emits server.install.failed                 ← severity='error'; payload.stage + errorMessage
```

#### Start (POST /servers/:id/start)

Source: [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts). Synchronous — emits before returning to the caller.

```
api emits server.start.requested
  ├─ bridge.containerInspect → if running: UPDATE servers SET status='running'
  │   └─ api emits server.start.done (payload.note='already running')
  └─ else:
     ├─ DB: UPDATE servers SET status='starting'
     ├─ liveBus.publish({type: 'server.status', status: 'starting'})
     ├─ bridge.containerStart OR bridge.containerRun
     └─ api emits server.start.done    ← payload.container_id + durationMs
─────── on any throw above ───────
api emits server.start.failed → re-throw
```

#### Stop (POST /servers/:id/stop)

Source: [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts). Synchronous, but blocks ~15 s on the graceful RCON wait. Sets a Redis fence at the start so the reconciler ([`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts)) can distinguish a planned stop from an unexpected exit.

```
api: SET stop:requested:{server_id} EX 300
api emits server.stop.requested            ← payload.method='graceful'
  ├─ DB: UPDATE servers SET status='stopping'
  ├─ liveBus.publish({type: 'server.status', status: 'stopping'})
  ├─ if creds + settings:
  │   ├─ rcon AdminBroadcast → api emits server.stop.broadcast (ok + raw_response)
  │   ├─ sleep 15s
  │   └─ rcon AdminEndMatch → api emits server.stop.end_match (ok)
  ├─ bridge.containerStop → api emits server.stop.container_stop (ok + durationMs)
  └─ api emits server.stop.done              ← payload.totalDurationMs
─────── on any throw above ───────
api emits server.stop.failed → re-throw

# later, asynchronously, when Docker reports Status=exited:
reconciler emits server.stop.reconciler_confirmed (Task 8 — not in this route)
```

The reconciler-confirmed event is documented separately because it lives in `plugins/status-reconciler.ts`.

#### Soft-delete (DELETE /servers/:id)

Source: [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts). Calls `softDeleteServer` from [`lib/server-delete.ts`](../../../apps/api/src/lib/server-delete.ts), which performs config backup → container stop+rm → directory delete → ufw rule remove → set `deletedAt`.

```
api emits server.soft_delete.requested
  ├─ softDeleteServer(...)                    ← reads + backs up configs, removes container, drops ufw rules
  └─ liveBus.publish({type: 'server.deleted', ...})
api emits server.soft_delete.done            ← payload.backup_id + files_backed_up + durationMs
─────── on throw ───────
api emits server.soft_delete.failed → 500 response
```

#### Restore (POST /servers/archive/:id/restore)

Source: [`routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts). Creates a NEW server row with a new uuid (`new_server_id`); the old archived server stays soft-deleted. The restored server is `pending` — operator must follow with `/install` + `/restore-configs` + `/start`.

```
api emits server.restore.requested            ← serverId = old archive id; payload.slug
  ├─ verify slug is free
  ├─ DB: insert new servers + serverSettings + serverCredentials rows
  └─ liveBus.publish({type: 'server.restored', old_server_id, new_server_id})
api emits server.restore.done                 ← serverId = NEW server id; payload.archive_id + new_server_id
```

#### Reconciler container-exit observation (background, every 4 s)

Source: [`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts). Runs on every tick (`RECONCILE_INTERVAL_MS = 4 s`) and on every `POST /servers/:id/reconcile`. Whenever a row's previous status is `running` and the docker-derived state maps to `stopped` (i.e. the container exited between this tick and the previous one), the reconciler emits diag events alongside the existing DB update + `liveBus.publish({type:'server.status'})`.

```
reconciler.tick(server):
  bridge.containerInspect → {state, exit_code, oom_killed, error, started_at, finished_at}
  mapState(state, running) → 'stopped'
  if previous === 'running' && next === 'stopped':
    DB: UPDATE servers SET status='stopped'
    liveBus.publish({type: 'server.status', source: 'reconciler', status: 'stopped'})

    fence = redis.GET stop:requested:{server.id}
    severity = exit_code === 0 ? 'info' : 'error'

    if fence is set:
      reconciler emits container.exited
        payload: {exit_code, oom_killed, signal, finished_at, started_at}
      reconciler emits server.stop.reconciler_confirmed   ← cap-off after a planned stop
        payload: {exit_code}
    else:
      reconciler emits container.unexpected_exit
        payload: {exit_code, oom_killed, signal, finished_at, started_at}
```

The fence `stop:requested:{server.id}` is `SET … EX 300` by the stop handler in [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts). The reconciler reads it with `GET` (does NOT consume) and lets it expire naturally; the next `/stop` request refreshes the TTL. The reconciler emit fires AFTER the DB update + LiveBus publish so a downstream consumer joining `events:server:{id}` and `diag:queue` sees the status change before the diag explanation.

`server.stop.reconciler_confirmed` only fires when the fence was set — if the panel never asked for a stop (a crash), the reconciler emits only `container.unexpected_exit`. This is what closes the loop opened in `POST /servers/:id/stop` (which emits `server.stop.requested` → `server.stop.done`); together they form: API requests stop → graceful RCON broadcast/end-match → bridge `containerStop` → reconciler observes the actual Docker exit and confirms it.

`pnpm verify:audit-chain` walks the table in `id` order and recomputes hashes; it exits non-zero on the first mismatch.
