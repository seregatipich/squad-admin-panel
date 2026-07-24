# Changelog — worker-automation

## 2026-07-24

### Added

- `AUTO-1` (#72): user-defined trigger rules ("if {condition} → {action}").
  - Tables `automation_rules` + `automation_runs` (`packages/db/src/schema/automation-rules.ts`, migration `0084_automation_rules.sql`).
  - Shared contracts + pure engine/actions in `@squad/shared-types` (`automation.ts`, `automation-engine.ts` `evaluate`, `automation-actions.ts` `runMatch` with the dry-run guard).
  - `src/rules/{runtime,deps,engine,actions}.ts`: the worker loads enabled rules (cached ~15s), evaluates event-driven conditions (`player_count`, `player_flag`, `time_of_day`) via an `onEnvelope` hook added to the dispatch loop, and executes actions (enqueue RCON / notify) while recording `automation_runs` + `audit_log`. `chat_keyword` is evaluated in `@squad/worker-log-ingest`'s `onChat`.
  - Managed via `apps/api/src/routes/automation-rules.ts` (CRUD + `:id/dry-run` + `automation-runs` history).
  - Added the `worker-automation` service to `docker-compose.yml` and `compose.tk104.yml`.
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