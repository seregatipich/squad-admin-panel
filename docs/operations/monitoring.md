# Monitoring

The panel's observability surface is intentionally minimal: two capped Redis Streams for logs and metrics, heartbeat keys for worker liveness, and the audit log for security forensics. There is no Prometheus exporter, no Grafana, and no external metrics push. See [architectural decision 2026-04-25 (panel observability)](../architecture/decisions.md) for the rationale.

## Panel logs

**Stream key**: `panel:logs` (capped at 100,000 entries, ~10 MB)

Every Fastify API log line, worker log line, and bridge log line is written to this stream by a pino multistream sink (`packages/shared-config/src/log-stream-sink.ts`). Entries are compact: source code (1 char), level code (1 char), message, optional server UUID, optional JSON context.

### Viewing logs

- **UI**: `/logs` page — filterable by source, level, server, and free text. Paginated, live-polling.
- **API**: `GET /api/v1/logs` — query params: `src`, `lvl`, `srv`, `q`, `before`, `after`, `limit` (max 2000). Requires `host:view` permission.
- **Export**: `GET /api/v1/logs/export` — streams a gzip-compressed bundle (recent entries + latest audit slice). Requires `host:metrics` permission. Attach to support requests.

Source codes: `B` = bridge, `R` = rcon, `L` = log-ingest, `W` = worker, `D` = depot, `I` = install, `A` = api.

### Raw Redis

```bash
docker compose exec redis redis-cli XLEN panel:logs
docker compose exec redis redis-cli XREVRANGE panel:logs + - COUNT 20
```

The stream is approximately bounded by size (`MAXLEN ~ 100000`); actual entry count may differ slightly due to Redis stream compaction.

## Host metrics

**Stream key**: `host:metrics` (capped at 5760 entries, 24 h at 4 samples/min)

`worker-metrics-sampler` calls `host_metrics` via the bridge every 15 seconds and appends a packed vector to this stream. Each entry holds CPU %, RAM used, disk %, network I/O rates, and load average as a compact `number[]` encoded under field `v`.

### Viewing metrics

- **UI**: Dashboard cards (CPU, RAM, Disk, Network). Click any card to open `MetricHistoryModal` — a time-series chart of the last 24 h.
- **API**: `GET /api/v1/host/metrics` (live snapshot). `GET /api/v1/host/metrics/history?seconds=86400` (historical, `ts[]` + `v[][]` arrays). Both require `host:metrics` permission.

### Raw Redis

```bash
docker compose exec redis redis-cli XLEN host:metrics
docker compose exec redis redis-cli XRANGE host:metrics - + COUNT 5
```

## Worker liveness

Workers publish a heartbeat to Redis at `worker:heartbeat:{name}` with a 30-second TTL on every iteration. If a worker hangs or crashes, its key expires and the UI shows it as dead.

**API**: `GET /api/v1/health/workers` — returns `{items: HeartbeatPayload[], total}`. No permission required (public health endpoint).

Current workers: `log-ingest`, `rcon`, `audit-archiver`, `event-partition`, `metrics-sampler`.

### Checking worker health

```bash
curl -sk https://${APP_DOMAIN}/api/v1/health/workers | jq .
docker compose logs worker-rcon --since 5m
docker compose logs worker-log-ingest --since 5m
docker compose logs worker-metrics-sampler --since 5m
```

A worker with `age_ms` above 60,000 in the API response is likely stuck. Restart it:

```bash
docker compose restart worker-rcon
```

## Bridge health

The bridge daemon has its own health check surface:

```bash
# From the host, as a panel-group member:
sg panel -c 'bash scripts/verify-bridge.sh'

# From the API:
curl -sk https://${APP_DOMAIN}/api/v1/host/bridge-status | jq .
# {"connected":true,"version":"...","hostname":"...","round_trip_ms":1}

# systemd status:
sudo systemctl status panel-host-bridge.service --no-pager
sudo journalctl -u panel-host-bridge -n 100
```

The `/ready` endpoint also probes the bridge:

```bash
curl -sk https://${APP_DOMAIN}/ready | jq .checks.bridge
```

## Audit log

`audit_log` is the security-grade append-only record of all state-mutating API calls. It is hash-chained: each row's `row_hash = sha256(prev_hash || canonical_json(row))`.

- **UI**: `/audit` page — shows actor (Steam display name or "system"), action, resource, timestamp.
- **Integrity check**: `DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain` — walks all rows, exits non-zero on the first broken link.

Do not use `audit_log` for diagnostic log noise. It covers only POST/PUT/PATCH/DELETE operations that mutate state. Read-only routes set `config.audit: false`.

## Diagnostic checklist

| Symptom | First steps |
|---|---|
| Dashboard shows "Bridge unhealthy" | `sudo systemctl status panel-host-bridge` → check if socket is active. If inactive: `sudo systemctl start panel-host-bridge.socket`. |
| Worker heartbeat missing | `docker compose logs worker-{name} --since 5m` → look for startup error. Check `DATABASE_URL` + `REDIS_URL` in compose env. |
| Metrics cards blank / stale | `docker compose logs worker-metrics-sampler --since 5m`. Check `PANEL_GID` in `.env` matches the `panel` group GID on the host (`getent group panel`). |
| `/logs` page empty | `XLEN panel:logs` in Redis. If zero, the pino sink may not have wired up — check `docker compose logs api --since 2m` for boot errors. |
| RCON status `not_polled` | Expected when the server is stopped. Only starts polling when `servers.status = 'running'`. |
| RCON status `error` | `docker compose logs worker-rcon --since 5m` — look for `ECONNREFUSED`. Check that the Squad container is running and RCON port is correct. |
| `/ready` returns 503 | `curl -sk .../ready | jq .checks` — which check failed? Restart the relevant service or the bridge. |

## No external monitoring (design choice)

The project deliberately excludes Prometheus, Grafana, Alertmanager, and external metric exporters. The two Redis streams and the heartbeat keys cover the operational needs of a self-hosted single-panel deployment. Alerting via the Discord worker is planned as a P2 feature.

## See also

- [`docs/architecture/decisions.md`](../architecture/decisions.md) — "Panel observability" decision record.
- [`docs/components/api/api.md`](../components/api/api.md) — `/api/v1/logs` and `/api/v1/host` route details.
- [`docs/operations/troubleshooting.md`](./troubleshooting.md) — deeper troubleshooting runbook.
