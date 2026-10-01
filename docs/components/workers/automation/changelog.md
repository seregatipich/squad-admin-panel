# Changelog — worker-automation

## 2026-09-30 — notify_admin without delivery is not counted as executed (#79)

### Fixed

- `notify_admin` is recorded in the history as `skipped` (`reason: 'not_delivered'`), not `executed`, when the delivery channel reports `delivered: false`. Right now the production implementation writes only a warn log and an audit record, so such runs show up as skipped.

## 2026-09-27 — player_count rules fire once per transition (#34)

### Fixed

- A `player_count` rule fired on every roster poll (`rcon.players_polled`, every 2 s) while the condition was true: an RCON command was queued, and rows were written to `automation_runs` and the append-only `audit_log` every 2 seconds. Now the rule fires only when the condition goes from "false" to "true" for each server. The latch is stored in Redis under the key `automation:pc:<ruleId>:<serverId>` (TTL 600 s, extended by every matching poll) and is released by the first poll on which the condition is false.

## 2026-09-28 — consumer groups on new and re-created streams (#60)

### Fixed

- A stream discovered after the loop started gets its consumer group at `0`, not `$`, so the first events of a new server's `events:server:<id>` stream (including the XADD that created it) are delivered. Streams present on the first discovery still start at `$`.
- `NOGROUP` from the multiplexed `XREADGROUP` clears the known-stream cache and re-creates the groups; a deleted and re-created stream no longer stops reading every stream until a restart.

## 2026-09-28

### Fixed

- #841: the dispatch loop no longer sets the dedup key before the side effect. It now reads the key, runs the plugins and the rule hook, and only then sets the key and acks; a failed rule hook (e.g. the database is down) leaves the entry pending, and a periodic `XAUTOCLAIM` sweep retries entries idle for more than 30 s.
- #843: stream discovery (`SCAN events:server:*`) and the reclaim sweep run every 30 s instead of on every poll.
- #844: a failing `XGROUP CREATE` no longer ends the loop — the stream is skipped and retried; a `NOGROUP` read error re-creates the groups; new groups start at `0`, so events published before a stream was discovered are delivered.
- #1292: if the dispatch loop ever rejects, the worker exits 1 instead of heartbeating while consuming nothing.
- #842: the `time_of_day` cooldown key is `automation:tod:<ruleId>:<serverId>`, so a global rule fires on every server; a serverless `events:global` envelope no longer spends the window of an RCON rule, and a failed firing releases it.

## 2026-07-24

### Added

- `AUTO-1` (#72): user-defined trigger rules ("if {condition} → {action}").
  - Tables `automation_rules` + `automation_runs` (`packages/db/src/schema/automation-rules.ts`, migration `0084_automation_rules.sql`).
  - Shared contracts + pure engine/actions in `@squad/shared-types` (`automation.ts`, `automation-engine.ts` `evaluate`, `automation-actions.ts` `runMatch` with the dry-run guard).
  - `src/rules/{runtime,deps,engine,actions}.ts`: the worker loads enabled rules (cached ~15s), evaluates event-driven conditions (`player_count`, `player_flag`, `time_of_day`) via an `onEnvelope` hook added to the dispatch loop, and executes actions (enqueue RCON / notify) while recording `automation_runs` + `audit_log`. `chat_keyword` is evaluated in `@squad/worker-log-ingest`'s `onChat`.
  - Managed via `apps/api/src/routes/automation-rules.ts` (CRUD + `:id/dry-run` + `automation-runs` history).
  - Added the `worker-automation` service to `docker/compose.yml` and `docker/compose.stand.yml`.
- Added `@squad/db`, `drizzle-orm`, and `uuid` dependencies.

### Changed

- `DATABASE_URL` is now a required environment variable (the worker previously had no Postgres dependency).

## 2026-07-09

### Added

- `INT-4`: plugin/event-hook system.
  - `packages/shared-types/src/plugins.ts`: `pluginManifest` Zod schema, `PLUGIN_PERMISSIONS`/`PluginPermission`, `PluginHandler` contract, `hasPluginPermission`.
  - `src/registry.ts`: `PluginRegistry` — validates manifests, indexes plugins by subscribed event kind.
  - `src/loader.ts`: `loadPlugins` + `BUILTIN_PLUGINS` (empty for this pass — in-process registration only, filesystem/dynamic loader documented as a follow-up).
  - `src/dispatch.ts`: Redis consumer-group loop (discovers `events:global` + per-server streams via `SCAN`, `XREADGROUP`, per-`event_id` dedup), permission-gated dispatch, per-plugin try/catch + timeout isolation.
  - `src/index.ts`: replaced the idle stub with the real dispatch loop; `REDIS_URL` is now required.
- Added `@squad/shared-types` dependency.
- Added `test/registry.test.ts`, `test/loader.test.ts`, `test/dispatch.test.ts` (unit), and `test/plugin-dispatch.test.ts` (integration, real Redis): envelope delivery, unsubscribed-kind exclusion, throwing/hanging-plugin isolation.

### Changed

- `REDIS_URL` is now a required environment variable (previously optional in the P2 stub).

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:automation` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.