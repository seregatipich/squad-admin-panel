# Workers

All workers live under [`apps/workers/`](../../../apps/workers/). Each is a standalone Node 22 process that:

- reports liveness via `worker:heartbeat:{name}` (TTL 30 s) using [`packages/shared-config/src/heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts),
- shuts down gracefully on `SIGINT`/`SIGTERM`, including a signal received during the first call to the database, Redis or the bridge.

Heartbeat keys are aggregated by the API at `/api/v1/health/workers`.

## Startup and shutdown contract

Workers with asynchronous startup must create
`createGracefulShutdownController()` before the first `await`. After the
initial pass has completed, call `markReady()` before scheduling intervals or
entering the main loop. The controller buffers a signal received during
startup and runs cleanup once; a repeated signal joins the same cleanup.

Workers built on [`@squad/worker-kit`](#worker-kit) get this from `runWorker`.

## Worker kit

[`packages/worker-kit`](../../../packages/worker-kit/) (`@squad/worker-kit`) holds the lifecycle the
periodic workers share. A worker's `src/index.ts` creates its logger with
`createWorkerLog(name)` (kept at module level for the worker's exported
functions) and ends with one `runWorker({ name, log, entrypoint: import.meta.url, ... })` call:

- `postgres` / `redis` declare what the worker opens. A missing `DATABASE_URL` or `REDIS_URL` is
  logged as `fatal` and exits with code `1`; `optional: true` lets the worker run without it
  (without Redis there is no heartbeat and the diag emitter is a no-op). `postgres.drizzle`
  also builds the Drizzle client as `ctx.db`; `postgres.options` overrides the default
  `{ max: 4, prepare: false }`.
- The heartbeat `worker:heartbeat:<name>` is published with `heartbeatStatus` (default `running`),
  and `<name_with_underscores>.started` / `.stopped` diag events are emitted unless
  `lifecycleDiag: false`.
- `setup(ctx)` runs synchronously and returns `ticks`: each has an `intervalMs`, a `run`, a
  `failureMessage`, an `overlap` policy (`'skip'`, `{ warn }`, or `'allow'`) and a `firstRunFailure`
  policy (`'fatal'`, the default, or `'log'`). It may also return `startedPayload` and a
  `beforeFirstTick` hook for one-shot startup work.
- On `SIGINT`/`SIGTERM` the kit clears the intervals, emits `stopped`, stops the heartbeat,
  closes Postgres and quits Redis. Importing a worker's entry file from a test does not start it.

`positiveIntEnv(name, fallback)` and `guardAgainstOverlap(tick, onSkip?)` are exported for workers
that run their own loops. Worker `tsconfig.json` files extend
[`apps/workers/tsconfig.base.json`](../../../apps/workers/tsconfig.base.json), and the plain
worker `vitest.config.ts` files spread
[`_test-shared/vitest.base.ts`](../../../apps/workers/_test-shared/vitest.base.ts).

Workers with a different lifecycle (a supervisor, a stream consumer, several loops with an ordered
teardown) keep their own `main()`.

Every worker contract test uses
[`apps/workers/_test-shared/contract.ts`](../../../apps/workers/_test-shared/contract.ts).
The shared test clears the heartbeat key, waits for a newly published
heartbeat, sends `SIGTERM` twice and requires a clean exit with code `0`.

## Implemented workers

Every directory under `apps/workers/` (except `_test-shared`) has a row here, 21 in total. Nineteen of them have a `worker-<name>` service in `docker/compose.yml`; `stats` is implemented but has no compose service, and `backup` is a placeholder (see below).

| Worker | Purpose | Directory |
|---|---|---|
| [rcon](./rcon/README.md) | Valve-RCON supervisor — roster and server-info polling, ShowServerInfo keepalive, publishes `rcon:status:{id}` | [`apps/workers/rcon/`](../../../apps/workers/rcon/) |
| [log-ingest](./log-ingest/README.md) | Tails `docker logs -f squad-{uuid}` via bridge, parses Squad log lines, emits events to Redis Streams | [`apps/workers/log-ingest/`](../../../apps/workers/log-ingest/) |
| [config-sync](./config-sync/README.md) | Consumes Admins.cfg sync events and writes managed role/group segments through the bridge | [`apps/workers/config-sync/`](../../../apps/workers/config-sync/) |
| [event-partition](./event-partition/README.md) | Hourly partition rotation for the partitioned tables (`events`, `diagnostic_events`, `player_sessions`, `chat_messages`, `bonus_transactions`, `combat_events`) and retention of the journal tables (see [retention windows](./event-partition/configuration.md#journal-table-retention-windows)) | [`apps/workers/event-partition/`](../../../apps/workers/event-partition/) |
| [role-expirer](./role-expirer/README.md) | Clears expired player roles, revokes sessions, audits the change, and enqueues Admins.cfg sync through the outbox; also VIP expiry reminders and subscription renewals | [`apps/workers/role-expirer/`](../../../apps/workers/role-expirer/) |
| [seed-reward](./seed-reward/README.md) | Reconciles rolling 30-day seed totals with the configured reward role | [`apps/workers/seed-reward/`](../../../apps/workers/seed-reward/) |
| [steam-refresh](./steam-refresh/README.md) | Refreshes seven-day-stale Steam profile, ban, ownership, and Squad playtime snapshots in bounded batches | [`apps/workers/steam-refresh/`](../../../apps/workers/steam-refresh/) |
| [leaderboard-aggregator](./leaderboard-aggregator/README.md) | Recomputes `player_stat_periods` leaderboard aggregates every 15 min (all-time rows at most hourly); also rebuilds the rolling 30-day bonus accrual window `player_bonus_accruals` (ECON-5) and materialises the running named season over its explicit window (LEAD-7) | [`apps/workers/leaderboard-aggregator/`](../../../apps/workers/leaderboard-aggregator/) |
| [presence-daily](./presence-daily/README.md) | Hourly rebuild of `player_daily_presence`, `server_daily_stats` and `player_coplay` for yesterday and today, plus daily economy bonus accrual; optional one-shot full co-play rebuild | [`apps/workers/presence-daily/`](../../../apps/workers/presence-daily/) |
| [ban-sync](./ban-sync/README.md) | Downloads enabled third-party ban lists, parses them and merges them into `external_bans` (never deleting rows); also serves manual sync requests from the `bansync:manual` stream | [`apps/workers/ban-sync/`](../../../apps/workers/ban-sync/) |
| [clan-guard](./clan-guard/README.md) | Warns and then kicks online players whose name carries a protected clan tag they do not own, via RCON commands queued for worker-rcon | [`apps/workers/clan-guard/`](../../../apps/workers/clan-guard/) |
| [clan-priority-expirer](./clan-priority-expirer/README.md) | Records expired clan reserved-slot priority windows once and enqueues an Admins.cfg sync per active server | [`apps/workers/clan-priority-expirer/`](../../../apps/workers/clan-priority-expirer/) |
| [metrics-sampler](./metrics-sampler/README.md) | Polls `bridge.host_metrics` every 15 s, writes packed 8-int tuple to `host:metrics` Redis Stream | [`apps/workers/metrics-sampler/`](../../../apps/workers/metrics-sampler/) |
| [worker-diag-flush](./worker-diag-flush/README.md) | Reads `diag:queue` Redis Stream via `XREADGROUP`, batches inserts into `diagnostic_events` Postgres table | [`apps/workers/diag-flush/`](../../../apps/workers/diag-flush/) |
| [media-publisher](./media-publisher/README.md) | Publishes stored media to YouTube/Telegram from the `media_publications` queue, with backoff and YouTube daily-quota deferral | [`apps/workers/media-publisher/`](../../../apps/workers/media-publisher/) |
| [discord](./discord/README.md) | Three loops: relays Squad server events to Discord webhooks (DISCORD-2), syncs panel roles to a Discord guild (DISCORD-5), and renames a live status channel plus registers read-only slash commands (DISCORD-6) | [`apps/workers/discord/`](../../../apps/workers/discord/) |
| [automation](./automation/README.md) | Event-hook plugin host (INT-4) and the AUTO-1 trigger-rule engine: evaluates `automation_rules` against events and executes the matching action | [`apps/workers/automation/`](../../../apps/workers/automation/) |
| [scheduler](./scheduler/README.md) | Seed schedules (SEED-3), rotation calendar (ROT-4), scheduled tasks (AUTO-2), map auto-selection (GAME-1) and season finalisation (LEAD-7), ticking every 30 s by default | [`apps/workers/scheduler/`](../../../apps/workers/scheduler/) |
| [stats](./stats/README.md) | Nightly dossier-aggregate reconcile guard (DOSSIER-2): recomputes per-weapon/per-vehicle stats from recent `combat_events` and alerts on drift, report-only; no compose service | [`apps/workers/stats/`](../../../apps/workers/stats/) |

## Stubs and placeholders

| Worker | Status | Directory |
|---|---|---|
| [audit-archiver](./audit-archiver/README.md) | Deployed, but a stub: it publishes a heartbeat whose status says archiving is not implemented (cold-archiving `audit_log` rows older than 90 days is planned) | [`apps/workers/audit-archiver/`](../../../apps/workers/audit-archiver/) |
| [backup](./backup/README.md) | Placeholder, not deployed (no compose service): scheduled backups run in the restic `backup` compose profile, not in this worker | [`apps/workers/backup/`](../../../apps/workers/backup/) |

## Adding a worker

1. Create `apps/workers/<name>/` with `package.json`, `tsconfig.json` (`{ "extends": "../tsconfig.base.json" }`), `src/index.ts`.
2. Build `src/index.ts` on [`@squad/worker-kit`](#worker-kit): `createWorkerLog` and `runWorker`. A worker that cannot use `runWorker` must call `startHeartbeat` from [`shared-config`](../shared-config/README.md) and register `createGracefulShutdownController()` before asynchronous startup, calling `markReady()` before it reports readiness.
3. Add `@squad/worker-kit` to the worker's `package.json` dependencies.
4. Cover heartbeat and repeated `SIGTERM` through the shared worker contract test.
5. Add it to `compose.yml`. If the worker needs the bridge socket, set `user: "0:${PANEL_GID:-987}"` (primary GID `panel`) — the bridge's `SO_PEERCRED` check looks at the peer's primary GID; supplementary groups added via `group_add` are not visible to the bridge across the user-namespace boundary.
6. Create a `docs/components/workers/<name>/` directory with the standard 7-file set (`README.md`, `api.md`, `configuration.md`, `data-model.md`, `flows.md`, `testing.md`, `troubleshooting.md`), add a row to the table above and link it from [`docs/README.md`](../../README.md).
