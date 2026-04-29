# worker-diag-flush — Configuration

## Environment variables

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | all | Postgres connection string used by `postgres(url, { max: 2 })`. | yes |
| `REDIS_URL` | no | `redis://localhost:6379` | all | ioredis connection string. In compose set to `redis://redis:6379`. | no |
| `DIAG_FLUSH_BATCH_SIZE` | no | `100` | all | `COUNT` argument passed to `XREADGROUP`. Higher = larger INSERTs, lower latency tolerance. | no |
| `DIAG_JOURNALD_FORWARD` | no | `true` | all | Set to `false` to disable the journald-bridge subprocess entirely (e.g. local dev where `panel-host-bridge` isn't running). | no |
| `DIAG_JOURNALD_UNIT` | no | `panel-host-bridge` | all | Systemd unit the journald forwarder tails. The bridge daemon's unit name. | no |
| `DIAG_JOURNALD_SINCE` | no | `30s ago` | all | `--since` window for the initial `journalctl -f` invocation. Larger windows replay more history on restart. | no |
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
    DIAG_JOURNALD_FORWARD: ${DIAG_JOURNALD_FORWARD:-true}
    DIAG_JOURNALD_UNIT: ${DIAG_JOURNALD_UNIT:-panel-host-bridge}
    DIAG_JOURNALD_SINCE: ${DIAG_JOURNALD_SINCE:-30s ago}
    LOG_LEVEL: ${LOG_LEVEL:-info}
  volumes:
    - /var/log/journal:/var/log/journal:ro
    - /etc/machine-id:/etc/machine-id:ro
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

### Journald access

The journald-bridge forwarder subprocess (`journalctl -u panel-host-bridge -o json -f`) needs to read the host journal. The compose service mounts:

- `/var/log/journal:/var/log/journal:ro` — the persistent journal directory. If your host runs only the volatile journal (`/run/log/journal`), also bind that path or set `Storage=persistent` in `/etc/systemd/journald.conf` and run `sudo systemctl restart systemd-journald` so the bridge's logs land on disk.
- `/etc/machine-id:/etc/machine-id:ro` — required by `journalctl` to map the journal files to the running host.

The `worker.Dockerfile` installs the `systemd` package (which provides the `journalctl` binary) only when `WORKER=diag-flush` to keep the other worker images slim. Set `DIAG_JOURNALD_FORWARD=false` if you intentionally do not want the forwarder (e.g. local dev where `panel-host-bridge` isn't running).

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
