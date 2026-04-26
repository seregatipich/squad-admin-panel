# `live-bus` — flows

## Topology

```
┌──────────────────────┐  publish    ┌─────────────┐  subscribe   ┌──────────────────────┐
│ status-reconciler    │────────────▶│             │             ▶│ /api/v1/ws/live      │
│ bridge-heartbeat     │             │  liveBus    │              │ (per-socket handler) │
│ (server-delete)      │  (in-proc)  │ EventEmitter│   in-proc    │                      │
│ (server-restore)     │             │             │              └──────────────────────┘
└──────────────────────┘             └──────┬──────┘                         ▲
                                            │ PUBLISH live-bus               │
                                            ▼                                │
                                     ┌─────────────┐                         │
                                     │   Redis     │                         │
                                     └──────┬──────┘                         │
                              SUBSCRIBE ────┴─────── SUBSCRIBE               │
                                       (this replica + other replicas)       │
                                            │                                │
                                            ▼                                │
                                  ┌────────────────────┐                     │
                                  │ live-bus subscriber│─────────────────────┘
                                  │  (re-emit local)   │
                                  └────────────────────┘
                                            ▲
                       ┌────────────────────┴────────────────────┐
                       │ PUBLISH rcon:status:changed             │
                       │     {server_id, state, player_count?}   │
                       └─────────────────────────────────────────┘
                                            ▲
                                            │
                                ┌─────────────────────────┐
                                │  worker-rcon            │
                                │  PerServerSupervisor    │
                                └─────────────────────────┘
```

## 1. In-process publish (main flow)

1. A producer (e.g. `status-reconciler`) calls `app.liveBus.publish(event)`.
2. The plugin's local `EventEmitter` fires `'event'` synchronously — every WS handler that called `app.liveBus.subscribe(cb)` runs `cb(event)` and writes the JSON frame to its socket.
3. The plugin then `void`-publishes the JSON to Redis on the `live-bus` channel for other replicas. Failure is logged and discarded; in-process subscribers were already served.

Latency budget: < 1 ms in-process; 1–5 ms cross-process via Redis on a healthy host.

## 2. Cross-replica fan-out

1. Replica A calls `liveBus.publish(event)` — local subs served.
2. Redis broadcasts to every subscriber, including Replica A's own `subscriber` connection AND Replica B's.
3. Replica A's subscriber sees its own message and re-emits it locally; the route handler dedupes by being already-served (the in-process emit happens BEFORE the publish, so listeners may receive the same event twice — acceptable for idempotent UI updates: setting `status: 'running'` twice is a no-op).
4. Replica B's subscriber sees the message, re-emits to its own listeners.

> Trade-off: we accept the double-delivery on the originating replica in exchange for keeping the publish path async. UI updates are CRDT-safe (last-writer-wins on a primitive status string) so this is benign.

## 3. RCON status fan-out (worker → API)

1. `PerServerSupervisor.writeStatus(state, extra)` runs after every state edge AND every successful poll.
2. It `SET`s `rcon:status:{server_id}` with TTL 300 s (existing behavior, source of truth).
3. It additionally `PUBLISH`es to `rcon:status:changed` with `{server_id, state, player_count?}`.
4. Every API replica's `live-bus` subscriber sees the publish, wraps it as `{type: 'rcon.status', ts: <fresh>, data: {...}}`, and emits it locally so attached WS clients see it.

If the publish fails (Redis blip), the SET still succeeded — the next REST `/api/v1/servers/:id/rcon` call returns the up-to-date value. The UI's REST fallback poll (every 120 s in Bundle F) catches drift.

## 4. Bridge connectivity fan-out

1. `bridge-heartbeat` pings every 5 s.
2. On `up`→`down` edge: emits `{type: 'bridge.connection', data: {state: 'down', down_for_s: 0}}`.
3. On `down`→`up` edge: computes `down_for_s = round((now - lastDownAt)/1000)` and emits `{state: 'up', down_for_s}`.
4. Steady-state ticks (still up, still down) emit nothing — only edges.

## 5. WebSocket lifecycle

1. Client opens `wss://.../api/v1/ws/live` with the session cookie.
2. `auth` plugin's `onRequest` hook runs even for the upgrade request; missing/invalid session → 401, no `server:view` permission → 403, neither produces a 101 upgrade.
3. On accept, the route registers a subscriber on `liveBus`, schedules a 10 s ping interval, and starts forwarding events.
4. Server pings every 10 s with `{"type":"ping","ts":"..."}`.
5. Client must reply with `{"type":"pong"}`. The handler updates `lastPongAt`. Any other JSON / non-JSON is ignored.
6. If `lastPongAt` is older than 30 s when the next ping fires, the server closes the socket (code 4000, reason `pong timeout`).
7. On `close`, the route clears the ping interval and calls the unsubscribe handle returned by `liveBus.subscribe`.

## 6. Redis disconnect / reconnect

`ioredis` auto-reconnects with the project's exponential backoff (`packages/api/src/plugins/redis.ts`). The dedicated subscriber connection inherits the same retry policy. While disconnected, `app.liveBus.publish()` still serves in-process subscribers; the Redis publish silently fails and is logged at warn. After reconnect, a fresh `SUBSCRIBE live-bus rcon:status:changed` is issued automatically by ioredis (it tracks active subscriptions).

> No replay buffer: events emitted while Redis was down are lost cross-replica. UI handles this by treating WS as best-effort and refreshing REST on focus.

## 7. Plugin shutdown

`onClose` hook:
1. `UNSUBSCRIBE live-bus rcon:status:changed`.
2. `subscriber.quit()`.
3. `emitter.removeAllListeners()` — defensive against late callbacks.
