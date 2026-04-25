# worker-metrics-sampler

## Purpose

Polls the host bridge for system metrics every 15 s and appends a packed 8-integer tuple to the `host:metrics` Redis Stream. The API reads this stream to serve the 24-hour host metrics history endpoint.

## Responsibilities

- Call `bridge.hostMetrics()` every 15 s.
- Pack the result into `[cpu_x100, ram_used_bytes, disk_used_bytes, net_rx_bps, net_tx_bps, la1_x100, la5_x100, la15_x100]` using `packHostMetrics`.
- `XADD host:metrics MAXLEN ~ 5760 * v <packed>`.
- Publish `worker:heartbeat:metrics-sampler` every 5 s.
- Log each sample as `debug` and any bridge failure as `warn`.

## What it does not do

- Does not write to Postgres.
- Does not read Redis Streams.
- Does not decode or aggregate metrics — that is the API's responsibility.

## Code location

```
apps/workers/metrics-sampler/
  src/
    index.ts      — entry point, bridge + Redis setup, heartbeat, shutdown
    sampler.ts    — runSampler() — timer loop, XADD
  test/
    sampler.test.ts
```

## Dependencies

- `@squad/bridge-client` — `hostMetrics` RPC
- `@squad/shared-config` — `startHeartbeat`, `redisSinkStream`, `HOST_METRICS_STREAM`, `HOST_METRICS_MAXLEN`, `packHostMetrics`
- `ioredis` — Redis client

## Bridge socket requirement

Requires primary GID `panel` (`user: "0:${PANEL_GID:-987}"` in `compose.yml`). `group_add: panel` does not work because the bridge's `SO_PEERCRED` check only sees the peer's primary GID in the host user namespace.

## Components that depend on it

- API — `GET /api/v1/host/metrics/history` reads `XRANGE host:metrics`.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
