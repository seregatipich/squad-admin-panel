# `live-bus` — typed WebSocket push channel

Process-local `EventEmitter` plus a Redis `PUB`/`SUB` fan-out, exposed to UI clients via a single authenticated WebSocket: `GET /api/v1/ws/live`. Every panel screen that needs near-real-time state (server status, RCON connectivity, bridge liveness) subscribes here instead of polling REST.

## Responsibilities

- Decorate the Fastify app with `app.liveBus.publish(event)` and `app.liveBus.subscribe(cb)`.
- Re-emit local publishes so same-process subscribers see them without round-tripping through Redis.
- Subscribe to the Redis channels `live-bus` and `rcon:status:changed` and re-emit any envelope they carry as `LiveEvent` frames so other API replicas and external workers can broadcast.
- Serve a single multiplexed WebSocket route that forwards every emitted event to every connected, authenticated client.
- Heartbeat the socket: server-side ping every 10 s, drop the socket if no client pong arrives within 30 s.

## What this component does NOT do

- It does NOT persist events. The event stream is a transient hot path; durable history lives in `events:server:{id}` Redis Streams + Postgres `events` table (see the [shared-types](../shared-types/README.md) component).
- It does NOT replay missed events on reconnect. A new socket starts from the next published event onward; the web client falls back to a single REST refresh on connect.
- It does NOT enforce per-event authorization. Auth is at socket-open (the `server:view` permission); every connected client sees every event.

## Code location

- Plugin: [`apps/api/src/plugins/live-bus.ts`](../../../apps/api/src/plugins/live-bus.ts)
- Route: [`apps/api/src/routes/live.ts`](../../../apps/api/src/routes/live.ts)
- Producers (server-side):
  - [`apps/api/src/plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts) — `server.status` on every reconciled state edge.
  - [`apps/api/src/plugins/bridge-heartbeat.ts`](../../../apps/api/src/plugins/bridge-heartbeat.ts) — `bridge.connection` on `up`↔`down` edges.
- Producers (worker-side):
  - [`apps/workers/rcon/src/supervisor.ts`](../../../apps/workers/rcon/src/supervisor.ts) — Redis `PUBLISH rcon:status:changed` on every status write; the API plugin re-wraps it as `rcon.status`.
- Test: [`apps/api/test/live-bus.test.ts`](../../../apps/api/test/live-bus.test.ts)

## Dependencies

- In: [`api`](../api/README.md) (registers the plugin and route), [`workers/rcon`](../workers/rcon/README.md) (publishes status changes).
- Out: Redis (pub/sub), `node:events`, `@fastify/websocket`.

## Components that depend on it

- [`web`](../web/README.md) — the UI subscribes through the WS for instant status updates and renders a connection banner from `bridge.connection`.

## Basic usage

Server-side:

```ts
app.liveBus.publish({
  type: 'server.status',
  ts: new Date().toISOString(),
  data: { server_id, status: 'running', source: 'reconciler' },
});
```

Client-side (browser):

```ts
const ws = new WebSocket('wss://admin.example/api/v1/ws/live');
ws.addEventListener('message', (msg) => {
  const event = JSON.parse(msg.data);
  if (event.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  else router.dispatch(event);
});
```

## See also

- [API reference](api.md) — wire format for every `LiveEvent` variant.
- [Data model](data-model.md) — envelope shape, channel layout.
- [Flows](flows.md) — producer → bus → consumer paths.
- [Configuration](configuration.md) — Redis channel names, ping/timeout constants.
- [Testing](testing.md) — the vitest suite + manual WS verification.
- [Troubleshooting](troubleshooting.md) — banner stuck red, missed events, dropped sockets.
- [Changelog](changelog.md)
