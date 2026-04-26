# Data flow

## Inputs

| Source | Path |
|---|---|
| Operator browser | `https://${APP_DOMAIN}/` → Caddy → `web` (Next.js) for HTML, `web → api` for HTTP/WebSocket |
| Squad game server | `docker logs -f squad-{uuid}` (parsed by `worker-log-ingest`) and TCP `127.0.0.1:{rcon_port}` (polled by `worker-rcon`) |
| Steam CDN | Read-only `depot_update` via `bridge` into the `squad-depot` named volume |

## Storage

| Store | Used by | What lives there |
|---|---|---|
| PostgreSQL | api, workers, db migrations | players (with `role_id`), sessions, roles, role_permissions, panel_meta (singleton), servers, config_versions, audit_log, events (partitioned monthly), processed_events |
| Redis | api, all workers | event streams `events:server:{id}` and `events:global`; connector-logs stream `panel:logs` (`MAXLEN ~ 100k`); host metrics history `host:metrics` (`XADD` capped); depot progress stream `depot:progress` (≤5k entries); status keys `rcon:status:{id}`, `worker:heartbeat:{name}` (TTL 30 s); blame cache `config-blame:{tip_version_id}` (TTL 24 h); install in-flight `depot:updating`; rate-limit counters |
| Host filesystem | bridge, server containers | `/var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg` (RW host, RW container), `/var/lib/squad-panel/saved/{uuid}/**` (RW), `/var/lib/docker/volumes/squad-depot/**` (RO) |

## Event pipeline

Every event uses the same envelope (see [`components/shared-types/data-model.md`](../components/shared-types/data-model.md)).

```
producer                                    consumer
┌─────────────────────┐                     ┌──────────────────────┐
│ worker-log-ingest   │                     │ players-projector    │
│ worker-rcon         │ ──Redis Stream──▶   │ (UPSERT players,     │
│ api (server.*)      │  events:server:{id} │  player_name_history)│
│ bridge connectors   │                     │                      │
└─────────────────────┘                     └──────────────────────┘
                       ─Redis Stream──▶     UI WebSocket mirror
                        events:global
```

Consumer-group naming: `<service>:v<schema-version>` (e.g. `players-projector:v1`). Bumping the version starts a fresh group that replays from the tail.

### Idempotency (dual-layer)

Every consumer does both before acting:

1. `SET dedup:${group}:${event_id} 1 EX 86400 NX` — fast short-circuit on redelivery.
2. `INSERT INTO processed_events (event_id, group_name) ON CONFLICT DO NOTHING` — durable guarantee that survives Redis restarts.

`XACK` runs only after the side-effect commits. On consumer failure the Redis dedup key is `DEL`-ed so `XAUTOCLAIM`'s retry can proceed.

### Reclaim / DLQ

- `XAUTOCLAIM` runs every 30 s with a 120 s idle threshold.
- After five deliveries to the same pending entry, the reclaimer moves the message to `events:dlq` and `XACK`s the original.

## Install flow (end to end)

```
UI install wizard                  api                       bridge
─────────────────                  ───                       ──────
POST /servers (name, ports) ────▶  INSERT servers (pending)
                                   201 ───────────────────▶  (no bridge call yet)

POST /servers/:id/install
(WebSocket upgrade) ────────────▶  ws plugin attaches a
                                   per-socket bridge client
                                   ──────────────────────▶   container_inspect squad-depot
                                                       ◀──   {exists: false}
                                   ──────────────────────▶   depot_update {steamcmd args validated}
                                                       ◀──   stream {stdout chunks…}
                                                       ◀──   {ok, exit_code: 0}
                                   seedConfigs():
                                     read 19 cfg from
                                     /var/lib/docker/volumes/squad-depot/_data/...
                                     write to /var/lib/squad-panel/configs/{uuid}/ServerConfig/
                                     INSERT config_versions × 19 (baseline)
                                   ──────────────────────▶   ufw_rule add … (×4)
                                   ──────────────────────▶   container_run {image, name, mounts, env, host_network}
                                                       ◀──   {ok, container_id}
status-reconciler (immediate on onReady, then every 4 s) ──▶  container_inspect
                                                       ◀──   {state: running}
                                   UPDATE servers SET status='running'
                                   liveBus.publish({type:'server.status', source:'reconciler'})
                                                                            (worker-rcon picks it up
                                                                             on next reconcile)
```

### Stop flow ordering (eager status update)

`POST /api/v1/servers/:id/stop` writes the row to `status='stopping'` BEFORE the slow RCON sequence + `container_stop`:

```
POST /servers/:id/stop ──▶  UPDATE servers SET status='stopping'
                            liveBus.publish({type:'server.status', source:'stop'})
                            (UI updates immediately)
                            ─bridge.rcon broadcast──▶ AdminBroadcast …
                            sleep 15 s
                            ─bridge.rcon end-match──▶ AdminEndMatch
                            ─bridge.containerStop({timeout_sec: 60})
status-reconciler (≤4 s later) ──▶ container_inspect
                                                  ◀── {state: 'exited'}
                                   UPDATE servers SET status='stopped'
```

If the API process crashes between the eager UPDATE and `container_stop`, the row sits in `stopping`; the next reconciler tick reads docker state and resolves it. This is why the plugin's `mapState` treats `not_found`, `exited`, and `dead` as `stopped` — Docker may have already cleaned up.

## Server lifecycle: deletion + restore

```
UI delete confirm                 api                                    bridge
─────────────────                 ───                                    ──────
DELETE /servers/:id ─────────▶  softDeleteServer(ctx, id):
                                 phase 1 (THROWS on total fail):
                                   for cfg in ALLOWED_CONFIG_FILES:
                                     ─bridge.fileRead({path})───────▶   read configs/{id}/ServerConfig/<cfg>
                                                              ◀────    {content}
                                   db.transaction:
                                     INSERT config_versions × N
                                       message='deletion-backup-marker <iso>'
                                     backup_marker_id = first row id
                                 phase 2 (best-effort):
                                   ─bridge.containerStop({timeout:30})▶ docker stop squad-{id}
                                   ─bridge.containerRm()─────────────▶  docker rm
                                 phase 3 (best-effort):
                                   ─bridge.directoryDelete(configs)──▶  os.RemoveAll /configs/{id}
                                   ─bridge.directoryDelete(saved)────▶  os.RemoveAll /saved/{id}
                                 phase 4 (best-effort):
                                   ─bridge.ufwRule({action:'remove'})▶  × game/query/beacon/rcon
                                 phase 5:
                                   UPDATE servers SET deleted_at=now(),
                                                      deleted_by_steam_id64,
                                                      deletion_backup_marker_id
                                   WHERE id=$1 AND deleted_at IS NULL
route:
  phase 6: audit_log row (action='server.delete', context=DeleteResult)
  phase 7: liveBus.publish({type:'server.deleted', data:{server_id, deleted_at, by}})
                                                                              │
                                                                              ▼
                                                                  every UI tab patches
                                                                  its /servers state
```

If phase 1 throws (zero readable cfg) the route returns 500 and the row stays alive. Phases 2-4 errors are recorded in `result.errors[]` and bubble into `audit_log.context.errors` — phase 5 always runs because the orchestrator does not throw on best-effort failures.

```
Restore (3 endpoints, UI wizard glues them together)
────────────────────────────────────────────────────
1. POST /servers/archive/:archiveId/restore       ─▶  INSERT servers (uuidv7, slug, ...)  → 409 on slug_in_use
                                                  ─▶  liveBus.publish({type:'server.restored', data:{old, new}})
2. POST /servers/:newId/install                   ─▶  existing install pipeline (depot → seedConfigs → ufw → container_run)
3. POST /servers/:newId/restore-configs           ─▶  SELECT config_versions WHERE message LIKE 'deletion-backup-marker%'
                                                       AND server_id=archiveId
                                                  ─▶  for each filename (skip Rcon.cfg):
                                                       bridge.fileAtomicWrite onto /configs/{newId}/ServerConfig/
                                                       INSERT config_versions (message='restored from server <id> backup <iso>')
4. POST /servers/:newId/start                     ─▶  bridge.containerStart
```

## Live-bus fan-out

```
producers                                          consumers
─────────                                          ─────────
status-reconciler (every 4s, on edge)
   │  liveBus.publish({type:'server.status', ...})
   ▼
bridge-heartbeat (every 5s, on up↔down edge)
   │  liveBus.publish({type:'bridge.connection', ...})
   ▼
DELETE /servers/:id (after softDeleteServer)
   │  liveBus.publish({type:'server.deleted', ...})
   ▼
POST /archive/:id/restore
   │  liveBus.publish({type:'server.restored', ...})
   ▼
                          ┌──────────────────────────────────────────────┐
                          │  app.liveBus.publish(event)                  │
                          │   1. localEmit  → in-process subscribers     │
                          │   2. redis PUBLISH live-bus <json>           │
                          └──────┬───────────────────────────────────────┘
                                 │
                ┌────────────────┴─────────────────────┐
                ▼                                      ▼
   redis SUBSCRIBE live-bus                 redis SUBSCRIBE rcon:status:changed
   (every API replica)                      (every API replica)
                │                                      │
                │                                      │  worker-rcon PerServerSupervisor
                │                                      │  PUBLISH rcon:status:changed
                │                                      │   {server_id, state, player_count?}
                ▼                                      ▼
   each replica re-emits to local           plugin re-stamps as
   subscribers; WS handlers forward          {type:'rcon.status', ts:<fresh>, data:{...}}
   to their connected browsers              and re-emits locally
                │
                ▼
   GET /api/v1/ws/live  ── per-socket route handler  ── browser
        ping every 10s, drop on no-pong > 30s (close 4000)
```

The originating replica's Redis subscriber will see its own publish back; the in-process emit fires BEFORE the publish so the in-process subscribers may receive the event twice. UI updates are last-writer-wins, so this is benign (see [`live-bus/flows.md`](../components/live-bus/flows.md#2-cross-replica-fan-out)).

## Connector logs pipeline

```
api / workers / bridge-event listeners
         │
         ▼  pino multistream with `log-stream-sink`
   redis XADD panel:logs MAXLEN ~ 100000 *
         s=<source code>  l=<level code>  m=<message>  i=<server uuid?>  c=<ctx json?>
         │
         ▼  GET /api/v1/logs?src=&lvl=&srv=&q=&before=&after=&limit=
   ui /logs page (LogList, polling)
         │
         ▼  GET /api/v1/logs/export
   gzipped operator bundle (panel logs + per-server log dumps)
```

Source codes: `B` bridge, `R` rcon, `L` log-ingest, `W` worker (generic), `D` depot, `I` install, `A` api. Levels: `D|I|W|E`. The encoder/decoder lives in [`packages/shared-config/src/log-stream.ts`](../../packages/shared-config/src/log-stream.ts).

## Host metrics history

```
worker-metrics-sampler  ─poll bridge.host_metrics→  bridge
         │
         ▼  redis XADD host:metrics MAXLEN ~ 5760 *  v=<json [cpu_x100, ram_used, disk_used, rx_bps, tx_bps, la1_x100, la5_x100, la15_x100]>
   redis stream  host:metrics
         │
         ▼  GET /api/v1/host/metrics/history?seconds=86400
   ui MetricHistoryModal → MetricHistoryChart (Recharts, lazy-loaded)
```

The packing format is a JSON tuple of 8 integers per sample (CPU and load averages multiplied by 100 to round-trip 2 decimals; RAM/disk/network values are bytes). 5760 samples = 24 h at 15 s cadence ≈ 300 KB total in Redis. The encode/decode helpers are `packHostMetrics` / `unpackHostMetrics` in [`packages/shared-config/src/metrics-pack.ts`](../../packages/shared-config/src/metrics-pack.ts); the web client inlines the unpack math because Next.js cannot bundle the `node:stream`-using log-stream sink that lives behind the same package barrel.

## Depot progress

```
POST /api/v1/depot/update   →  api spawns dedicated bridge connection
                                   │
                                   ▼  bridge.depot_update streams stdout/stderr
                              api XADDs each frame to depot:progress
                                   │
                                   ▼
              WS /api/v1/depot/progress/ws   ──replays last 500 + tails──→  ui
```

Multiple UI tabs can subscribe to the same update; the lock key `depot:updating` prevents concurrent runs.

## RCON polling loop

```
worker-rcon supervisor (every 5 s reconcile)
    │
    ▼
list servers WHERE status IN ('starting','running')
    │
    for each new target:
    ▼
TCP connect 127.0.0.1:{rcon_port}
two-packet AUTH (Squad's quirk — see protocol.ts)
publish rcon.connected on events:server:{id}
SET rcon:status:{id} {state:'connected', ...} EX 300
    │
    ▼  every 30 s
ListPlayers → parse → publish rcon.players_polled
    │
    ▼  every 90 s
ShowServerInfo (keepalive — RCON socket dies silently otherwise)
```

When a server transitions to `stopped`/`failed`, the supervisor drops it from `targets`. `rcon:status:{id}` expires after 300 s; the API surfaces this as `{state: 'not_polled'}` (rendered "— (сервер не запущен)").

## Error cases

| Failure | Surfaced as |
|---|---|
| Bridge subprocess crash | `app.bridge` reconnects on next call. `bridge-client.attachHandlers` deliberately does NOT set `closed=true` on decode errors — closing wedges every subsequent caller. |
| `container_run` exits non-zero | `ok:false, code:'runtime_error'` to the install WebSocket; install flow fails the install row and emits `server.install.failed`. |
| Worker stops sending heartbeats | `worker:heartbeat:{name}` TTL expires (30 s). `/api/v1/health/workers` reports stale; UI dashboard shows red. |
| Audit chain break | `pnpm verify:audit-chain` exits non-zero with the first broken row id. Treat as an incident. |
| Status-reconciler can't reach Docker | Per-server consecutive `container_inspect` failures are counted in `bridge_failures_by_server` (visible at `GET /api/v1/health/reconciler`). Log cadence: silent on attempt 1, `warn` at 5/30/every 60th. The DB row stays at its last status — ops can force a single-server reconcile via `POST /api/v1/servers/:id/reconcile`. `worker-rcon` heartbeat continues unaffected. |
| Status-reconciler returns an unmapped docker state | The plugin logs `'unknown docker state'` at warn and leaves the DB row alone. The row appears in `stuck_servers[]` after `STUCK_AFTER_MS` (90 s). Add the new state to `mapState`'s switch and ship a patch — the reconciler refuses to guess. |
