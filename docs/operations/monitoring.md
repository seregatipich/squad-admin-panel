# Monitoring

The panel's observability surface is intentionally minimal: two capped Redis Streams for logs and metrics, heartbeat keys for worker liveness, and the audit log for security forensics. There is no Prometheus exporter, no Grafana, and no external metrics push. (The API process does keep an in-process `@prometheus-io/client` registry at `GET /metrics`, labelled by route template only; it requires the `host:metrics` permission and is not routed by Caddy, so it is reachable only from inside the compose network or with an operator session.) See [architectural decision 2026-04-25 (panel observability)](../architecture/decisions.md) for the rationale.

## Panel logs

**Stream key**: `panel:logs` (capped at 100,000 entries, ~10 MB)

Every Fastify API log line, worker log line, and bridge log line is written to this stream by a pino multistream sink (`packages/shared-config/src/log-stream-sink.ts`). Entries are compact: source code (1 char), level code (1 char), message, optional server UUID, optional JSON context.

### Viewing logs

- **UI**: `/logs` page — filterable by source, level, server, and free text. Paginated, live-polling.
- **API**: `GET /api/v1/logs` — query params: `src`, `lvl`, `srv`, `q`, `before`, `after`, `limit` (max 2000). Returns `{ entries, cursor }`; tail with `after=<cursor>`. Requires `host:view` permission.
- **Export**: `GET /api/v1/logs/export` — streams a gzip-compressed bundle (recent entries + latest audit slice). Requires `host:view`, `host:metrics`, `audit:view` and `server:download_logs` together, because the bundle carries panel logs, the audit slice and game-server stdout tails (player IPs); an API token needs all four scopes. Attach to support requests.

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

Workers that publish a heartbeat in the default compose stack (19, one `worker-<name>` service each): `log-ingest`, `config-sync`, `rcon`, `audit-archiver`, `event-partition`, `presence-daily`, `role-expirer`, `seed-reward`, `steam-refresh`, `media-publisher`, `leaderboard-aggregator`, `diag-flush`, `metrics-sampler`, `clan-guard`, `automation`, `scheduler`, `ban-sync`, `clan-priority-expirer`, `discord`. `apps/workers/` holds 21 worker directories; `backup` (an idle placeholder, backups run in the restic `backup` compose profile) and `stats` have no compose service. See [workers](../components/workers/README.md).

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
docker compose exec api wget -qO- http://localhost:3000/ready | jq .checks.bridge
```

`/ready` is public, so each check reports only `ok` or `fail` and every probe gives up after 3 s. The reason for a `fail` (connection error, bridge socket path, timeout) is logged by the API as `readiness check failed` with the check name.

The dashboard reads the same checks (without the reason for a failure) from the authenticated `GET /api/v1/health/dependencies` (`host:view`), because the proxy hides `/ready`.

## Audit log

`audit_log` is the security-grade append-only record of all state-mutating API calls. It is hash-chained: each row's `row_hash = sha256(prev_hash || canonical_json(row))`.

- **UI**: `/audit` page — shows actor (Steam display name or "system"), action, resource, timestamp.
- **Integrity check**: `DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain` — walks all rows, exits non-zero on the first broken link. Record the chain head outside the database (`AUDIT_CHAIN_PRINT_HEAD=1`) and pass it back as `AUDIT_CHAIN_ANCHOR=<id>:<row_hash>` to also detect a truncated tail (see [migrations.md](./migrations.md#audit-chain-integrity)).

Do not use `audit_log` for diagnostic log noise. It covers only POST/PUT/PATCH/DELETE operations that mutate state. Read-only routes set `config.audit: false`.

## Live events feed: NOTIFY load

The API's live event list (`server.events.appended` frames) is driven by a
Postgres trigger on `events` that calls `pg_notify('events_appended', …)` once per
insert statement (migration 0132); `apps/api/src/plugins/events-feed.ts` LISTENs
and coalesces over 250 ms. Every transaction that calls `pg_notify` takes
Postgres's single notification-queue lock at commit, so the design only becomes a
bottleneck when a very large number of separate commits write `events`.

Measured on the dev stand (2026-09-23 to 2026-09-30): about 1,200 rows a day
(only `squad.*` and `server.seeding_*` kinds, combat hits live in their own
table), busiest second 5 rows, the whole database about 4 commits a second, queue
usage 0. That is three orders of magnitude below where the lock matters, so the
trigger is kept on purpose (audit finding #1327, issue #51).

Check it any time:

```bash
docker compose exec postgres psql -U admin -d admin -c "select pg_notification_queue_usage()"
docker compose exec postgres psql -U admin -d admin -c "select max(c) from (select date_trunc('second', occurred_at) s, count(*) c from events where occurred_at > now() - interval '24 hours' group by 1) t"
```

Revisit when `pg_notification_queue_usage()` stays above 0.1, or when the busiest
second regularly exceeds 100 rows. The rollback-safe path is two releases: first
add a second delivery channel (a Redis publish from the `events` writers, or an
API-side poll of new rows) while the trigger stays, because the previous release's
API receives live events only through `LISTEN events_appended`; drop the trigger
in the release after that.

## Diagnostic checklist

| Symptom | First steps |
|---|---|
| Dashboard shows "Bridge unhealthy" | `sudo systemctl status panel-host-bridge` → check if socket is active. If inactive: `sudo systemctl start panel-host-bridge.socket`. |
| Worker heartbeat missing | `docker compose logs worker-{name} --since 5m` → look for startup error. Check `DATABASE_URL` + `REDIS_URL` in compose env. |
| Metrics cards blank / stale | `docker compose logs worker-metrics-sampler --since 5m`. Check `PANEL_GID` in `.env` matches the `panel` group GID on the host (`getent group panel`). |
| `/logs` page empty | `XLEN panel:logs` in Redis. If zero, the pino sink may not have wired up — check `docker compose logs api --since 2m` for boot errors. |
| RCON status `not_polled` | Expected when the server is stopped. Only starts polling when `servers.status = 'running'`. |
| RCON status `error` | `docker compose logs worker-rcon --since 5m` — look for `ECONNREFUSED`. Check that the Squad container is running and RCON port is correct. |
| `/ready` returns 503 | `docker compose exec api wget -qO- http://localhost:3000/ready` — which check is `fail`? The api log line `readiness check failed` carries the reason. Restart the relevant service or the bridge. |

## No external monitoring (design choice)

The project deliberately excludes Prometheus, Grafana, Alertmanager, and external metric exporters. The two Redis streams and the heartbeat keys cover the operational needs of a self-hosted single-panel deployment. Operator alerting is built into the panel instead: AUTO-3 alert rules (`/api/v1/alert-rules`) are evaluated by `worker-log-ingest` against log-derived events, each firing is stored in `alert_events`, pushed to the UI as an `alert.triggered` live-bus frame and delivered over the e-mail and web-push channels (`apps/workers/log-ingest/src/alerts/`). `worker-discord` relays Squad server events to Discord webhooks; it is not an alert channel.

## See also

- [`docs/architecture/decisions.md`](../architecture/decisions.md) — "Panel observability" decision record.
- [`docs/components/api/api.md`](../components/api/api.md) — `/api/v1/logs` and `/api/v1/host` route details.
- [`docs/operations/troubleshooting.md`](./troubleshooting.md) — deeper troubleshooting runbook.
