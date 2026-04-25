# Workers

All workers live under [`apps/workers/`](../../../apps/workers/). Each is a standalone Node 22 process that:

- reports liveness via `worker:heartbeat:{name}` (TTL 30 s) using [`packages/shared-config/src/heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts),
- gracefully drains on `SIGTERM`.

Heartbeat keys are aggregated by the API at `/api/v1/health/workers`.

## Implemented workers

| Worker | Purpose | Directory |
|---|---|---|
| [rcon](./rcon/README.md) | Valve-RCON supervisor — ListPlayers polling, ShowServerInfo keepalive, publishes `rcon:status:{id}` | [`apps/workers/rcon/`](../../../apps/workers/rcon/) |
| [log-ingest](./log-ingest/README.md) | Tails `docker logs -f squad-{uuid}` via bridge, parses Squad log lines, emits events to Redis Streams | [`apps/workers/log-ingest/`](../../../apps/workers/log-ingest/) |
| [audit-archiver](./audit-archiver/README.md) | Cold-archives `audit_log` rows older than 90 days (P1 stub, heartbeat only in P0) | [`apps/workers/audit-archiver/`](../../../apps/workers/audit-archiver/) |
| [event-partition](./event-partition/README.md) | Monthly Postgres partition rotation for the `events` table | [`apps/workers/event-partition/`](../../../apps/workers/event-partition/) |
| [metrics-sampler](./metrics-sampler/README.md) | Polls `bridge.host_metrics` every 15 s, writes packed 8-int tuple to `host:metrics` Redis Stream | [`apps/workers/metrics-sampler/`](../../../apps/workers/metrics-sampler/) |

## Stub workers (P2, not implemented)

| Worker | Eventual purpose | Directory |
|---|---|---|
| [automation](./automation/README.md) | User-defined rules ("on event X, do Y") | [`apps/workers/automation/`](../../../apps/workers/automation/) |
| [backup](./backup/README.md) | restic-based DB + config snapshots | [`apps/workers/backup/`](../../../apps/workers/backup/) |
| [config-sync](./config-sync/README.md) | Push-to-Git for config history | [`apps/workers/config-sync/`](../../../apps/workers/config-sync/) |
| [discord](./discord/README.md) | Webhook + bot relay | [`apps/workers/discord/`](../../../apps/workers/discord/) |
| [scheduler](./scheduler/README.md) | Cron-style server restarts, layer rotations | [`apps/workers/scheduler/`](../../../apps/workers/scheduler/) |
| [stats](./stats/README.md) | Player-stats projector for the future stats UI | [`apps/workers/stats/`](../../../apps/workers/stats/) |

## Adding a worker

1. Create `apps/workers/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`.
2. Use [`shared-config`](../shared-config/README.md)'s `startHeartbeat` util.
3. Add it to `compose.yml`. If the worker needs the bridge socket, set `user: "0:${PANEL_GID:-987}"` (primary GID `panel`) — the bridge's `SO_PEERCRED` check looks at the peer's primary GID; supplementary groups added via `group_add` are not visible to the bridge across the user-namespace boundary.
4. Create a `docs/components/workers/<name>/` directory with the standard 8-file set and add a row to the table above.
