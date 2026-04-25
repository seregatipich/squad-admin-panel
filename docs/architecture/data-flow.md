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
| PostgreSQL | api, workers, db migrations | users, sessions, servers, players, config_versions, audit_log, events (partitioned monthly), processed_events |
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
status-reconciler (every 4 s) ──▶  container_inspect
                                                       ◀──   {state: running}
                                   UPDATE servers SET status='running'
                                                                            (worker-rcon picks it up
                                                                             on next reconcile)
```

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
| Status-reconciler can't reach Docker | Servers stuck in their last-known status; `worker-rcon` heartbeat continues unaffected. |
