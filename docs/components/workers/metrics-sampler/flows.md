# worker-metrics-sampler — Flows

## Startup

1. Read `REDIS_URL` from environment; fatal-exit if missing.
2. Connect to Redis.
3. Create `BridgeClient` (socket path from `BRIDGE_SOCKET` or `/run/panel-host-bridge.sock`).
4. Start heartbeat (`worker:heartbeat:metrics-sampler`, every 5 s).
5. Call `runSampler({ bridge, redis, log })`.

## Sample loop (every 15 s)

`runSampler` fires immediately on start and then on every 15 s interval.

For each tick:

1. `bridge.hostMetrics()` → `HostMetrics` struct.
2. `packHostMetrics(m)` → `number[]` of 8 integers.
3. `redis.xadd('host:metrics', 'MAXLEN', '~', '5760', '*', 'v', JSON.stringify(v))`.
4. `log.debug({ v }, 'metrics sample stored')`.

On bridge failure:

- `log.warn({ err }, 'metrics sample failed: …')`.
- Continue; next tick will retry.

The sampler never stops retrying after errors. Bridge reconnection is handled by `BridgeClient` automatically.

## Graceful shutdown (SIGTERM / SIGINT)

1. `stopSampler()` — clears the interval timer.
2. `stopHeartbeat()`.
3. `redis.quit()`.
4. `bridge.close()`.
5. `process.exit(0)`.
