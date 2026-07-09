# worker-automation

## Purpose

Plugin/event-hook host (`INT-4`). Loads an in-process plugin set and dispatches every `EventEnvelope` published to the shared event streams (`EVT-1`, see `apps/workers/log-ingest`) to plugins subscribed to its kind. Future automation rules ("when event X occurs on server Y, execute action Z" — `AUTO-1`) and alerts (`AUTO-3`) are expected to be built as plugins on top of this host.

## Current status — INT-4 (event hooks)

The worker:

- Loads a compiled-in plugin set (`src/loader.ts`) into a `PluginRegistry` (`src/registry.ts`), which validates each plugin's manifest (Zod schema in `@squad/shared-types`'s `pluginManifest`) and indexes it by subscribed event kind.
- Runs a Redis consumer-group loop (`src/dispatch.ts`) that discovers the shared `events:global` stream plus every per-server `events:server:<id>` stream (via `SCAN`, not a DB query — the worker has no Postgres dependency), reads `EventEnvelope`s, and dispatches each to subscribed plugins.
- Enforces a capability gate per plugin manifest (`requestedPermissions`): a plugin without `events:read` is never dispatched to; one without `events:payload` still runs but receives the envelope with `payload` redacted to `null`.
- Isolates every plugin invocation: a throwing or hanging (past a timeout) plugin is logged and skipped without affecting delivery to any other subscriber or crashing the worker.
- Deduplicates by `event_id` per consumer group via the `dedup:<group>:<event_id>` Redis key (mirrors the idea documented in `worker-log-ingest`'s `publish.ts`).
- Publishes `worker:heartbeat:automation` to Redis via `startHeartbeat`.

`BUILTIN_PLUGINS` (in `src/loader.ts`) is empty for this pass — no first-party automation plugin (`AUTO-1` triggers, `AUTO-3` alerts, ...) has landed yet.

## What it does not do yet

- Does not ship any first-party plugin (rule evaluation, alerting, chat commands) — those are follow-up backlog items (`AUTO-1`..`AUTO-4`).
- Does not load plugins from the filesystem or a package registry — only plugins compiled into `BUILTIN_PLUGINS` can run. A dynamic/filesystem plugin loader is a documented follow-up.
- Does not persist plugin enablement to Postgres — registration is in-code only for this pass.
- Does not act back on the system (send RCON commands, mutate Postgres) on a plugin's behalf — plugin handlers only observe events in this pass.

## Code location

```
apps/workers/automation/
  src/
    index.ts     — wires redis, plugin registry/loader, dispatch loop, heartbeat, graceful shutdown
    registry.ts   — PluginRegistry: manifest validation + per-kind subscriber index
    loader.ts     — loadPlugins() + BUILTIN_PLUGINS (empty for this pass)
    dispatch.ts   — Redis consumer-group loop, permission gate, timeout/error isolation, dedup
```

Shared plugin contract: `packages/shared-types/src/plugins.ts` (`pluginManifest`, `PLUGIN_PERMISSIONS`, `PluginHandler`, `hasPluginPermission`).

## Dependencies

- `pino` — structured logging
- `ioredis` — Redis client (`xadd`/`xreadgroup`/`xgroup`/`xack`/`scan`, consumer groups)
- `@squad/shared-config` — heartbeat helper
- `@squad/shared-types` — `EventEnvelope`, plugin manifest/permission schemas

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
