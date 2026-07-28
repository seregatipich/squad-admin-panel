# Workers

All workers live under [`apps/workers/`](../../../apps/workers/). Each is a standalone Node 22 process that:

- reports liveness via `worker:heartbeat:{name}` (TTL 30 s) using [`packages/shared-config/src/heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts),
- корректно завершает работу по `SIGINT`/`SIGTERM`, включая сигнал во время первого обращения к базе, Redis или мосту.

Heartbeat keys are aggregated by the API at `/api/v1/health/workers`.

## Startup and shutdown contract

Workers with asynchronous startup must create
`createGracefulShutdownController()` before the first `await`. After the
initial pass has completed, call `markReady()` before scheduling intervals or
entering the main loop. The controller buffers a signal received during
startup and runs cleanup once; a repeated signal joins the same cleanup.

Every worker contract test uses
[`apps/workers/_test-shared/contract.ts`](../../../apps/workers/_test-shared/contract.ts).
The shared test clears the heartbeat key, waits for a newly published
heartbeat, sends `SIGTERM` twice and requires a clean exit with code `0`.

## Implemented workers

| Worker | Purpose | Directory |
|---|---|---|
| [rcon](./rcon/README.md) | Valve-RCON supervisor — ListPlayers polling, ShowServerInfo keepalive, publishes `rcon:status:{id}` | [`apps/workers/rcon/`](../../../apps/workers/rcon/) |
| [log-ingest](./log-ingest/README.md) | Tails `docker logs -f squad-{uuid}` via bridge, parses Squad log lines, emits events to Redis Streams | [`apps/workers/log-ingest/`](../../../apps/workers/log-ingest/) |
| [config-sync](./config-sync/README.md) | Consumes Admins.cfg sync events and writes managed role/group segments through the bridge | [`apps/workers/config-sync/`](../../../apps/workers/config-sync/) |
| [audit-archiver](./audit-archiver/README.md) | Cold-archives `audit_log` rows older than 90 days (P1 stub, heartbeat only in P0) | [`apps/workers/audit-archiver/`](../../../apps/workers/audit-archiver/) |
| [event-partition](./event-partition/README.md) | Monthly Postgres partition rotation for the `events` table | [`apps/workers/event-partition/`](../../../apps/workers/event-partition/) |
| [role-expirer](./role-expirer/README.md) | Clears expired player roles, revokes sessions, audits the change, and enqueues Admins.cfg sync | [`apps/workers/role-expirer/`](../../../apps/workers/role-expirer/) |
| [seed-reward](./seed-reward/README.md) | Reconciles rolling 30-day seed totals with the configured reward role | [`apps/workers/seed-reward/`](../../../apps/workers/seed-reward/) |
| [steam-refresh](./steam-refresh/README.md) | Refreshes seven-day-stale Steam profile, ban, ownership, and Squad playtime snapshots in bounded batches | [`apps/workers/steam-refresh/`](../../../apps/workers/steam-refresh/) |
| leaderboard-aggregator | Recomputes `player_stat_periods` leaderboard aggregates every 15 min; also rebuilds the rolling 30-day bonus accrual window `player_bonus_accruals` (ECON-5) and materialises the running named season over its explicit window (LEAD-7) | [`apps/workers/leaderboard-aggregator/`](../../../apps/workers/leaderboard-aggregator/) |
| [metrics-sampler](./metrics-sampler/README.md) | Polls `bridge.host_metrics` every 15 s, writes packed 8-int tuple to `host:metrics` Redis Stream | [`apps/workers/metrics-sampler/`](../../../apps/workers/metrics-sampler/) |
| [worker-diag-flush](./worker-diag-flush/README.md) | Reads `diag:queue` Redis Stream via `XREADGROUP`, batches inserts into `diagnostic_events` Postgres table | [`apps/workers/diag-flush/`](../../../apps/workers/diag-flush/) |
| [media-publisher](./media-publisher/README.md) | Publishes stored media to YouTube/Telegram from the `media_publications` queue, with backoff and YouTube daily-quota deferral | [`apps/workers/media-publisher/`](../../../apps/workers/media-publisher/) |

## Stub workers (P2, not implemented)

| Worker | Eventual purpose | Directory |
|---|---|---|
| [automation](./automation/README.md) | User-defined rules ("on event X, do Y") | [`apps/workers/automation/`](../../../apps/workers/automation/) |
| [backup](./backup/README.md) | restic-based DB + config snapshots | [`apps/workers/backup/`](../../../apps/workers/backup/) |
| [discord](./discord/README.md) | Webhook + bot relay | [`apps/workers/discord/`](../../../apps/workers/discord/) |
| [scheduler](./scheduler/README.md) | Cron-style server restarts, layer rotations, season finalisation (LEAD-7) | [`apps/workers/scheduler/`](../../../apps/workers/scheduler/) |
| [stats](./stats/README.md) | Player-stats projector for the future stats UI | [`apps/workers/stats/`](../../../apps/workers/stats/) |

## Adding a worker

1. Create `apps/workers/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`.
2. Use [`shared-config`](../shared-config/README.md)'s `startHeartbeat` util.
3. Register `createGracefulShutdownController()` before asynchronous startup and call `markReady()` before the worker reports readiness.
4. Cover heartbeat and repeated `SIGTERM` through the shared worker contract test.
5. Add it to `compose.yml`. If the worker needs the bridge socket, set `user: "0:${PANEL_GID:-987}"` (primary GID `panel`) — the bridge's `SO_PEERCRED` check looks at the peer's primary GID; supplementary groups added via `group_add` are not visible to the bridge across the user-namespace boundary.
6. Create a `docs/components/workers/<name>/` directory with the standard 8-file set and add a row to the table above.
