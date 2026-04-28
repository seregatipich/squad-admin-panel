# worker-diag-flush — Configuration

## Environment variables

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | all | Postgres connection string used by `postgres(url, { max: 2 })`. | yes |
| `REDIS_URL` | no | `redis://localhost:6379` | all | ioredis connection string. In compose set to `redis://redis:6379`. | no |
| `DIAG_FLUSH_BATCH_SIZE` | no | `100` | all | `COUNT` argument passed to `XREADGROUP`. Higher = larger INSERTs, lower latency tolerance. | no |
| `LOG_LEVEL` | no | `info` | all | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). Set to `debug` to log every parsed row. | no |
| `HOSTNAME` | no | unset | all | Read by `startHeartbeat` and included in the heartbeat payload. Docker sets it automatically. | no |
| `VITEST` | no | unset | tests only | If set to `'true'` the module exports `flushBatch` without auto-running `main()`. | no |

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Consumer-group name | `diag-flush` | `GROUP` in [`src/index.ts`](../../../../apps/workers/diag-flush/src/index.ts) |
| Consumer name | `diag-flush-${process.pid}` | `CONSUMER` in [`src/index.ts`](../../../../apps/workers/diag-flush/src/index.ts) |
| `XREADGROUP BLOCK` | `1000` ms | `BLOCK_MS` in [`src/index.ts`](../../../../apps/workers/diag-flush/src/index.ts) |
| Stream key | `diag:queue` | `DIAG_STREAM_KEY` in [`packages/shared-config/src/diag.ts`](../../../../packages/shared-config/src/diag.ts) |
| Stream `MAXLEN` (producer) | `100000` | `DIAG_STREAM_MAXLEN` (in `@squad/diag`) — set by the producer, not by this worker |
| Postgres pool size | `max: 2` | `postgres(url, { max: 2 })` in `main()` |
| Heartbeat interval | `5 000` ms | `startHeartbeat` default |
| Heartbeat TTL | `30` s | `HEARTBEAT_TTL_SECONDS` |
| INSERT idempotency | `ON CONFLICT (id, ts) DO NOTHING` | `flushBatch` |

## docker-compose service

```yaml
worker-diag-flush:
  build: { context: ., dockerfile: docker/worker.Dockerfile, args: { WORKER: diag-flush } }
  restart: unless-stopped
  environment:
    DATABASE_URL: postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin
    REDIS_URL: redis://redis:6379
    DIAG_FLUSH_BATCH_SIZE: ${DIAG_FLUSH_BATCH_SIZE:-100}
    LOG_LEVEL: ${LOG_LEVEL:-info}
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    migrator:
      condition: service_completed_successfully
  logging: *default-logging
```

The worker does NOT need bridge socket access (no `volumes` entry for `/run/panel-host-bridge.sock`). It also does NOT need `network_mode: host` — Redis and Postgres are reached over the compose network.

## Tunable knobs

- **Higher throughput**: raise `DIAG_FLUSH_BATCH_SIZE` to 500 or 1000. Each batch is one INSERT round-trip; larger batches amortise the per-statement cost. Watch the slowest pg query in the log for a tail-latency rise.
- **Lower latency**: lower `BLOCK_MS` (currently hard-coded). Not env-overridable yet because 1 s is already short relative to the 5 s heartbeat cadence.
- **More replicas**: scale to 2+ instances for read parallelism. Each consumer in the group sees disjoint entries (Redis Streams partitions by consumer). The `${process.pid}` suffix means each replica has a unique consumer name automatically. **Caveat**: the gap noted in `flows.md` ("crash recovery") still applies — pending entries from a dead replica need `XAUTOCLAIM` reclaim.

## Local development

```sh
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @squad/worker-diag-flush dev
```

Run `pnpm --filter @squad/worker-diag-flush test` for the unit tests; no infra needed (the test mocks both `sql` and `redis`).
