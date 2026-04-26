# `live-bus` — testing

## Test files

| File | Tier | Covers |
|---|---|---|
| [`apps/api/test/live-bus.test.ts`](../../../apps/api/test/live-bus.test.ts) | unit / integration | (1) `liveBus.publish()` reaches a connected WebSocket client with the correct envelope. (2) Client `pong` frames reset the liveness timer (no premature disconnect). (3) `socket.on('close')` releases the subscriber so handler counts do not leak. |

## Running

```bash
pnpm --filter @squad/api exec vitest run test/live-bus.test.ts
```

Part of the regular suite — `pnpm --filter @squad/api test` includes it; `pnpm turbo run test` includes it transitively. No DB or Redis required (the plugin gracefully degrades to single-process when the redis decoration lacks `duplicate()`).

## Test fixture pattern

The vitest spins up a minimal Fastify app:

1. Decorates `app.redis` with an empty `{}` to opt into the single-process fallback.
2. Registers `@fastify/websocket`, then `liveBusPlugin`, then `liveRoutes`.
3. Listens on `127.0.0.1:0` so the OS picks a free port.
4. Each case opens a real `ws` client, drives the bus from server-side, and asserts on received frames.

This mirrors the pattern used by `apps/api/test/server-logs.test.ts` and `apps/api/test/install-ws.test.ts`. The `auth` plugin is intentionally NOT registered in this suite — the `audit-coverage.test.ts` CI guard separately verifies that `config.permissions` is declared on the route.

## What is covered

- WS forwarding of a `LiveEvent` (server.status as exemplar).
- Client `pong` heartbeat does NOT trigger a disconnect.
- `liveBus.subscribe` returns a working unsubscribe handle (verified by closing the socket then registering a probe and counting deliveries).
- Audit-coverage CI guard accepts `audit: false` on the route (validated by re-running `apps/api/test/audit-coverage.test.ts`).

## What is NOT covered (explicit gaps)

- Cross-process Redis pub/sub fan-out (would need a real Redis or `ioredis-mock`; e2e suite in Bundle H will exercise this against the live stack).
- The 30-second pong timeout path (would lengthen the suite by 30 s; covered by code review and manual smoke).
- Authentication + RBAC enforcement on the route — covered upstream by the `audit-coverage` and `permission-matrix` suites.
- Producer wiring (status-reconciler, bridge-heartbeat, worker-rcon) — those producers' own suites assert on the original behavior; the publish call is a one-liner and visible in the diff.

## Mocks / stubs / fakes

- `app.redis = {}` — minimal stub. The plugin's runtime guard (`typeof app.redis?.duplicate === 'function'`) takes the single-process branch.
- No bridge, no DB, no real Redis.

## Manual verification

```bash
# 1. Real stack up.
docker compose up -d

# 2. Open WS as logged-in operator (replace cookie with real __Host-sid value).
websocat -H 'Cookie: __Host-sid=<real cookie>' wss://admin.localhost/api/v1/ws/live

# 3. In another terminal, kill the bridge container to force the down edge.
docker stop panel-host-bridge

# Expected: within ~5 s the websocat session prints
#   {"type":"bridge.connection","ts":"...","data":{"state":"down","down_for_s":0}}
# Restarting brings:
#   {"type":"bridge.connection","ts":"...","data":{"state":"up","down_for_s":<seconds>}}
```
