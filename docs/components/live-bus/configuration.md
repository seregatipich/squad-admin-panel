# `live-bus` — configuration

## Constants (compiled in)

These are not user-tunable today; change them by editing the source. Trade-offs documented inline.

| Constant | Value | File | Rationale |
|---|---|---|---|
| `LIVE_BUS_CHANNEL` | `'live-bus'` | `apps/api/src/plugins/live-bus.ts` | Cross-replica fan-out channel for full `LiveEvent` JSON. |
| `RCON_STATUS_CHANNEL` | `'rcon:status:changed'` | `apps/api/src/plugins/live-bus.ts` | Worker-rcon → API edge channel. Also used by `worker-rcon` `PerServerSupervisor.writeStatus`. |
| `setMaxListeners` | `1024` | `apps/api/src/plugins/live-bus.ts` | One listener per open WebSocket; lifted from default 10 so 200+ concurrent tabs do not warn. |
| `PING_INTERVAL_MS` | `10_000` | `apps/api/src/routes/live.ts` | Server-side liveness ping. Short enough that proxies (Caddy, nginx) don't see idle silence. |
| `PONG_TIMEOUT_MS` | `30_000` | `apps/api/src/routes/live.ts` | Allows a missed ping plus normal jitter before declaring the client gone. |

## Required environment variables

`live-bus` is wired via `apps/api/src/server.ts` and shares the API process's environment. The only var it materially depends on:

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `REDIS_URL` | yes | — | all | ioredis-style URL (`redis://[:pass@]host:port/db`). The plugin issues `app.redis.duplicate()` for the subscriber connection. | yes (if password) |

No live-bus-specific env vars exist. If you add one (e.g. a feature flag), document it here and in [`docs/operations/environment-variables.md`](../../operations/environment-variables.md).

## Production tuning

- **Sticky sessions**: not required. The cross-replica Redis fan-out means any client can land on any API replica and see every event.
- **WebSocket through Caddy**: the existing [`docker/Caddyfile`](../../../docker/Caddyfile) already passes `Upgrade: websocket` headers; no changes needed for `/api/v1/ws/live`.
- **Backpressure**: `socket.send` in the route handler is non-blocking; if the client buffer fills the socket dies on the next ping cycle. There is no per-client outbound queue today — acceptable because every event is small (< 1 KB) and infrequent (event rate << 100/s in normal operation).

## Test mode

In unit tests the plugin tolerates a redis decoration that lacks `duplicate()`/`publish()`/`subscribe()`. It logs a warn (`live-bus: redis client lacks duplicate(); running in single-process mode`) and serves only in-process subscribers. The vitest suite at `apps/api/test/live-bus.test.ts` relies on this fallback.
