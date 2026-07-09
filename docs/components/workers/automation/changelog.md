# Changelog — worker-automation

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