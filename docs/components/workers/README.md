# `workers` — background workers

All workers live under [`apps/workers/`](../../../apps/workers/). Each is a standalone Node 22 process that:

- subscribes to or publishes from Redis Streams,
- reports liveness via `worker:heartbeat:{name}` (TTL 30 s) using [`packages/shared-config/src/heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts),
- gracefully drains on `SIGTERM`.

Heartbeat keys are aggregated by the API at `/api/v1/health/workers`.

## P0 workers (active)

### `worker-rcon`

Code: [`apps/workers/rcon/src/`](../../../apps/workers/rcon/src/).

- **Supervisor** ([`supervisor.ts`](../../../apps/workers/rcon/src/supervisor.ts)) reconciles the running set every 5 s: `SELECT id, rcon_port, rcon_password_encrypted FROM servers WHERE status IN ('starting','running')`.
- For each new target, opens TCP to `127.0.0.1:<rcon_port>`, runs the **two-packet AUTH** in [`protocol.ts`](../../../apps/workers/rcon/src/protocol.ts) (Squad's quirk: it sends an empty `SERVERDATA_AUTH_RESPONSE` with id 0 followed by the real one).
- Polls `ListPlayers` every 30 s (`parse-list-players.ts`) and `ShowServerInfo` every 90 s (`parse-server-info.ts`, used as a keepalive — RCON otherwise dies silently).
- Publishes `rcon.connected`, `rcon.disconnected`, `rcon.players_polled` envelopes to `events:server:{id}`.
- Maintains `rcon:status:{id}` in Redis with TTL 300 s. Absence ⇒ API surfaces `{state: 'not_polled'}` (rendered "— (сервер не запущен)").
- Persists player rows + `player_name_history` via [`persist.ts`](../../../apps/workers/rcon/src/persist.ts).

### `worker-log-ingest`

Code: [`apps/workers/log-ingest/src/`](../../../apps/workers/log-ingest/src/).

- For each running server, runs `bridge.container_logs_follow squad-{uuid}` ([`tail.ts`](../../../apps/workers/log-ingest/src/tail.ts)).
- Regex-parses `SquadGame.log` lines in [`parser/`](../../../apps/workers/log-ingest/src/parser/).
- Emits `server.ready`, `server.stopped`, `server.crashed`, `player.connected`, `player.disconnected`, `player.name_changed`, `match.started`, `match.ended` to `events:server:{id}`.

### `worker-audit-archiver`

Code: [`apps/workers/audit-archiver/`](../../../apps/workers/audit-archiver/).

- Cron-style: every hour, snapshots `audit_log` rows older than 90 days into a JSONL file under the host filesystem (path configurable). Updates a marker row before deletion. Deletion is `DELETE FROM audit_log_archive_view WHERE …`, where the view bypasses the append-only trigger via `SECURITY DEFINER`.

### `worker-event-partition`

Code: [`apps/workers/event-partition/`](../../../apps/workers/event-partition/).

- Monthly partition rotation for the `events` table. Pre-creates next month's partition on the 25th; detaches and archives partitions older than 12 months.

### `worker-metrics-sampler`

Code: [`apps/workers/metrics-sampler/`](../../../apps/workers/metrics-sampler/).

- Polls [`bridge.host_metrics`](../bridge/api.md#host_metrics--hostmetrics) every 15 s and `XADD`s a packed 8-integer tuple (`v: [cpu_x100, ram_used_bytes, disk_used_bytes, net_rx_bps, net_tx_bps, la1_x100, la5_x100, la15_x100]`) to the `host:metrics` Redis Stream (`HOST_METRICS_STREAM` from [`packages/shared-config/src/metrics-pack.ts`](../../../packages/shared-config/src/metrics-pack.ts)). The Redis stream-id millisecond prefix is the timestamp — `ts` is not stored as a separate field.
- The 24 h history feed at [`GET /api/v1/host/metrics/history`](../api/api.md#host) is `XRANGE` over this stream. The API decodes via `unpackHostMetrics`; the web modal inlines the same math because `shared-config`'s barrel re-exports a `node:stream`-using module that Next.js refuses to bundle for the client.
- Stream is `XADD MAXLEN ~ HOST_METRICS_MAXLEN` (5760 = 24 h at 15 s cadence, ≈ 300 KB total) — old samples drop automatically.
- Logs every sample as `debug` and any failure as `warn` through the standard pino multistream sink, so failures land in `panel:logs` for the connector-logs UI.
- Heartbeats as `worker:heartbeat:metrics-sampler`.
- **Bridge auth requirement:** the compose entry uses `user: "0:${PANEL_GID:-987}"` — primary GID `panel` is required by the host bridge's `SO_PEERCRED` check. Using `group_add: panel` does not work because the bridge runs in the host user namespace and only sees the peer's primary GID; supplementary groups added inside the container aren't visible across the namespace boundary.

## Stub workers (post-P0)

Each ships a no-op `index.ts` and a heartbeat. Wiring will land with the matching feature.

| Worker | Eventual purpose |
|---|---|
| `worker-automation` | User-defined rules ("on event X, do Y"). |
| `worker-backup` | restic-based DB + configs snapshots. |
| `worker-config-sync` | Push-to-Git for cfg history. |
| `worker-discord` | Webhook + bot relay. |
| `worker-scheduler` | Cron-style server restarts, layer rotations. |
| `worker-stats` | Player-stats projector for the future stats UI. |

## Adding a worker

1. Create `apps/workers/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`.
2. Use [`shared-config`](../shared-config/README.md)'s heartbeat util.
3. Add it to `compose.yml`. Bind-mount the bridge socket only if needed; if so, set `user: "0:${PANEL_GID:-987}"` (primary GID `panel`) — the bridge's `SO_PEERCRED` check looks at the peer's primary GID, and supplementary groups added via `group_add` aren't visible to the bridge across the user-namespace boundary.
4. Document it here and in [`development/local-development.md`](../../development/local-development.md).
