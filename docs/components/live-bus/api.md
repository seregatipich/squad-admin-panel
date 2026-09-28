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

Subscription acknowledgements (see below) list the socket's current opt-in subscriptions:

```json
{"type": "subscribed",   "events": ["chat.message"]}
{"type": "unsubscribed", "events": []}
```

#### Client → server frames

```json
{"type": "pong"}
{"type": "subscribe",   "events": ["chat.message", "combat.event"]}
{"type": "unsubscribe", "events": ["chat.message"]}
```

Any other JSON — including a subscription frame whose `events` is not an array of at most 64 non-empty strings of at most 64 characters — is silently ignored. Non-JSON is silently ignored.

#### Event subscriptions (#69)

Each modelled event type is either `broadcast` or `opt_in` (`EVENT_DELIVERY` in `apps/api/src/routes/live.ts`; the TypeScript `Record` forces a choice for every new `LiveEvent` type):

- `broadcast` types reach every connection, subject to the per-event filters (`combat:view`, role assignment, own session/upload).
- `opt_in` types — `chat.message`, `combat.event`, `rcon.roster`, `externalban.matched` — and every worker-published type the API union does not model (`banname.matched`, `bansync.*`, `match.*`, …) reach a socket only after it sent `subscribe` for that type, until `unsubscribe`.
- Subscribing to `chat.message` replays the chat ring buffer (last 100 per server, all servers); subscribing to `combat.event` replays the combat buffer when the connection has `combat:view`. Nothing is replayed on connect. A `server.deleted` event drops that server's buffered tail.

The web client (`apps/web/src/lib/live-bus.ts`) subscribes to every type a mounted `useLiveSubscription` consumer listens to, reference-counted, and re-sends the set after each reconnect.

#### Heartbeats

- Server pings every **10 s** (`PING_INTERVAL_MS`).
- Client must reply with `{"type":"pong"}` within **30 s** of any ping; otherwise the server closes the socket with code `4000` and reason `"pong timeout"`.
- Reconnect policy lives client-side (see `apps/web/src/lib/live-bus.ts` in Bundle F).

#### Revocation (#12)

The server never relies on the client to honour a revocation:

- A `session.revoked` frame whose `session_id` is this socket's own session is sent to the client and the server then closes the socket with code `4001`, reason `"session revoked"`. Other sessions of the same player receive the frame but stay open.
- Every **30 s** (`DEFAULT_REVALIDATE_INTERVAL_MS`, the `revalidateIntervalMs` plugin option) the socket re-resolves its session (or, for a Bearer connection, its API token) and reloads the player's permissions:
  - session gone, expired or revoked, or token revoked → close `4001`, reason `"session revoked"`;
  - no `server:view` any more (for a `self_service` session: no `panel_access`) → close `4003`, reason `"forbidden"`;
  - otherwise the `combat:view` and role-assignment filters are updated from the fresh permissions — for a Bearer connection narrowed to the token's scopes (`narrowToTokenScopes`), so a token never gains `combat:view` or role-assignment alerts its scopes do not delegate.
- A re-check that fails because Postgres or Redis is unavailable keeps the socket and retries on the next tick.

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
