# `live-bus` — API reference

## WebSocket route

### `GET /api/v1/ws/live`

- **Permission**: `server:view` (enforced by the standard `auth` plugin via the route's `config.permissions`).
- **Audit**: `false` — no mutations.
- **Auth**: cookie session (`__Host-sid`). Bearer tokens with the `server:view` scope are also accepted (same path through `auth` plugin).
- **Response**: WebSocket upgrade (101). On auth failure the upgrade is rejected with `401 unauthenticated` or `403 forbidden`.

#### Server → client frames

Every frame is JSON; `type` is the discriminator.

```json
{"type": "ping", "ts": "2026-04-26T12:00:00.000Z"}
```

Plus any `LiveEvent`:

```json
{"type": "server.status",     "ts": "...", "data": {"server_id": "uuid", "status": "running",  "source": "reconciler|install|delete"}}
{"type": "server.deleted",    "ts": "...", "data": {"server_id": "uuid", "deleted_at": "...",  "by": "steam_id64|null"}}
{"type": "server.restored",   "ts": "...", "data": {"old_server_id": "uuid", "new_server_id": "uuid"}}
{"type": "rcon.status",       "ts": "...", "data": {"server_id": "uuid", "state": "connected|connecting|disconnected", "player_count": 42}}
{"type": "server.events.appended", "ts": "...", "data": {"server_id": "uuid|null", "kinds": ["player.connected"]}}
{"type": "bridge.connection", "ts": "...", "data": {"state": "up|down", "down_for_s": 12}}
{"type": "worker.heartbeat",  "ts": "...", "data": {"worker": "rcon",   "healthy": true}}
```

#### Client → server frames

```json
{"type": "pong"}
```

Any other JSON is silently ignored. Non-JSON is silently ignored.

#### Heartbeats

- Server pings every **10 s** (`PING_INTERVAL_MS`).
- Client must reply with `{"type":"pong"}` within **30 s** of any ping; otherwise the server closes the socket with code `4000` and reason `"pong timeout"`.
- Reconnect policy lives client-side (see `apps/web/src/lib/live-bus.ts` in Bundle F).

## Fastify decorations

Provided by `apps/api/src/plugins/live-bus.ts`.

### `app.liveBus.publish(event: LiveEvent): void`

- Emits `event` to every in-process subscriber synchronously.
- Fires Redis `PUBLISH live-bus <json>` in the background; failures are logged and swallowed (UI subscribers in this process still receive the event).
- Returns immediately; never throws.

### `app.liveBus.subscribe(cb: (event: LiveEvent) => void): () => void`

- Registers `cb` against the in-process emitter.
- Returns an unsubscribe function. Always call it on socket close to avoid leaking the handler (the route does this in `socket.on('close')`).

## TypeScript types

```ts
export type LiveEvent =
  | { type: 'server.status';     ts: string; data: { server_id: string; status: string; source: 'reconciler' | 'install' | 'delete' } }
  | { type: 'server.deleted';    ts: string; data: { server_id: string; deleted_at: string; by: string | null } }
  | { type: 'server.restored';   ts: string; data: { old_server_id: string; new_server_id: string } }
  | { type: 'rcon.status';       ts: string; data: { server_id: string; state: string; player_count?: number } }
  | { type: 'bridge.connection'; ts: string; data: { state: 'up' | 'down'; down_for_s: number } }
  | { type: 'worker.heartbeat';  ts: string; data: { worker: string; healthy: boolean } };
```

## Redis pub/sub channels

| Channel | Direction | Producer | Consumer | Payload |
|---|---|---|---|---|
| `live-bus` | API → API replicas | `app.liveBus.publish()` | `live-bus` plugin subscriber | Full `LiveEvent` JSON. |
| `rcon:status:changed` | worker-rcon → API | `PerServerSupervisor.writeStatus` | `live-bus` plugin subscriber | `{server_id, state, player_count?}`; the plugin wraps it into a `rcon.status` `LiveEvent` with a fresh `ts`. Published on every state change and whenever a rendered connected-state field changes (player/squad count, map, next layer, mode, queue) — not on every refresh. |
| `rcon:refresh` | worker-log-ingest → worker-rcon | `publishRconRefreshHint` | worker-rcon hint subscriber | `{server_id, scopes: ("roster"\|"info")[], reason?}` — re-poll that server now. |

`server.events.appended` does not travel over Redis from a worker: every API replica LISTENs on the Postgres channel `events_appended` (trigger `trg_events_notify_appended`, migration 0116) and publishes the frame locally. Frames carry no event rows; clients refetch `GET /api/v1/events`.

The plugin re-publishes its locally-emitted events to `live-bus` so other API instances see them. The local emitter delivery is synchronous and happens BEFORE the Redis publish, so a single API replica never round-trips through Redis to talk to itself.
