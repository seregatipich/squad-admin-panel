# `live-bus` — data model

## In-memory state

The plugin owns a single `node:events.EventEmitter` instance keyed under the `'event'` channel. `setMaxListeners(1024)` raises the default 10-listener cap so a busy panel with many open browser tabs does not log warnings.

There is **no persistence**. Restarting the API drops in-flight subscribers; reconnecting clients see only events emitted after their socket re-opens.

## `LiveEvent` envelope

```ts
type LiveEvent =
  | { type: 'server.status';     ts: ISO8601; data: ServerStatusData }
  | { type: 'server.deleted';    ts: ISO8601; data: ServerDeletedData }
  | { type: 'server.restored';   ts: ISO8601; data: ServerRestoredData }
  | { type: 'rcon.status';       ts: ISO8601; data: RconStatusData }
  | { type: 'bridge.connection'; ts: ISO8601; data: BridgeConnectionData }
  | { type: 'worker.heartbeat';  ts: ISO8601; data: WorkerHeartbeatData };
```

`ts` is always set by the producer (or by the `live-bus` plugin when wrapping an `rcon:status:changed` payload). It is informational; the receiver MUST NOT use it for ordering — Redis pub/sub does not guarantee ordering across replicas.

### Variant payloads

| Variant | `data` fields | Required producer | Notes |
|---|---|---|---|
| `server.status` | `server_id: uuid`, `status: string`, `source: 'reconciler'\|'install'\|'delete'` | `status-reconciler` plugin (today) | `status` matches `servers.status` enum: `pending`, `installing`, `ready`, `starting`, `running`, `stopping`, `stopped`, `failed`. |
| `server.deleted` | `server_id: uuid`, `deleted_at: ISO8601`, `by: steam_id64\|null` | `DELETE /api/v1/servers/:id` route handler in [`apps/api/src/routes/servers.ts`](../../../apps/api/src/routes/servers.ts) after `softDeleteServer` resolves. | Emitted only on success (the soft-delete UPDATE in phase 5 already ran). `by` is the actor's `steam_id64` as a string, or `null` for system-driven deletes. |
| `server.restored` | `old_server_id: uuid`, `new_server_id: uuid` | `POST /api/v1/servers/archive/:id/restore` in [`apps/api/src/routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts). | Emitted right after the new `servers` row is inserted. The new server is still in `pending`; subsequent install + restore-configs do not emit a separate restore event — UI shows progress through `server.status` instead. |
| `rcon.status` | `server_id: uuid`, `state: 'connected'\|'connecting'\|'disconnected'`, `player_count?: number` | `worker-rcon` `PerServerSupervisor` via Redis `PUBLISH rcon:status:changed` | The full extra payload that lives under `rcon:status:{id}` (e.g. `tickrate_rt`, `current_map`) is NOT forwarded — only the headline state and player count. UI fetches detail via REST. |
| `bridge.connection` | `state: 'up'\|'down'`, `down_for_s: number` | `bridge-heartbeat` plugin | `down_for_s` is `0` on a fresh `down` edge; the value is computed and emitted again on the recovering `up` edge. |
| `worker.heartbeat` | `worker: string`, `healthy: boolean` | Reserved for future use | Not emitted yet. |

## Redis channels

| Channel | Wire format | Lifetime |
|---|---|---|
| `live-bus` | UTF-8 JSON of a `LiveEvent`. Up to ~64 KB; oversized messages indicate a producer bug. | None — pub/sub, never persisted. |
| `rcon:status:changed` | UTF-8 JSON `{ server_id: uuid, state: string, player_count?: number }`. | None. The `live-bus` plugin re-stamps `ts` and re-emits as a `rcon.status` `LiveEvent`. |

## Migrations

None. Adding a new `LiveEvent` variant is a backward-compatible change: existing clients ignore unknown `type` values. Removing or renaming a variant is breaking; use a deprecation period.

## Example records

```json
{"type":"server.status","ts":"2026-04-26T12:00:00.000Z","data":{"server_id":"019dbac8-ceb0-77ab-859b-bfa9a282ee2c","status":"running","source":"reconciler"}}
{"type":"bridge.connection","ts":"2026-04-26T12:00:05.000Z","data":{"state":"down","down_for_s":0}}
{"type":"bridge.connection","ts":"2026-04-26T12:00:21.000Z","data":{"state":"up","down_for_s":16}}
{"type":"rcon.status","ts":"2026-04-26T12:00:30.000Z","data":{"server_id":"019dbac8-ceb0-77ab-859b-bfa9a282ee2c","state":"connected","player_count":42}}
```
