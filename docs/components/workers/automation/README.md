# worker-automation

## Purpose

Plugin/event-hook host (`INT-4`) **and** the AUTO-1 trigger-rule engine (`#72`). It dispatches every `EventEnvelope` published to the shared event streams (`EVT-1`, see `apps/workers/log-ingest`) to in-process plugins subscribed to its kind, and — after plugin dispatch — evaluates the user-defined `automation_rules` against the same event and executes each match's action.

## Current status — INT-4 (event hooks)

The worker:

- Loads a compiled-in plugin set (`src/loader.ts`) into a `PluginRegistry` (`src/registry.ts`), which validates each plugin's manifest (Zod schema in `@squad/shared-types`'s `pluginManifest`) and indexes it by subscribed event kind.
- Runs a Redis consumer-group loop (`src/dispatch.ts`) that discovers the shared `events:global` stream plus every per-server `events:server:<id>` stream (via `SCAN`, not a DB query — the worker has no Postgres dependency), reads `EventEnvelope`s, and dispatches each to subscribed plugins.
- Enforces a capability gate per plugin manifest (`requestedPermissions`): a plugin without `events:read` is never dispatched to; one without `events:payload` still runs but receives the envelope with `payload` redacted to `null`.
- Isolates every plugin invocation: a throwing or hanging (past a timeout) plugin is logged and skipped without affecting delivery to any other subscriber or crashing the worker.
- Deduplicates by `event_id` per consumer group via the `dedup:<group>:<event_id>` Redis key (mirrors the idea documented in `worker-log-ingest`'s `publish.ts`).
- Publishes `worker:heartbeat:automation` to Redis via `startHeartbeat`.

`BUILTIN_PLUGINS` (in `src/loader.ts`) is empty — no first-party *plugin* has landed; AUTO-1 rule evaluation runs as a built-in `onEnvelope` hook, not as a plugin.

## AUTO-1 (#72) — trigger rules

- Loads enabled `automation_rules` (cached ~15s) and, for each event, builds a trigger input and evaluates every in-scope rule with the pure engine (`@squad/shared-types`'s `evaluate`). Event-driven conditions handled here: `player_count` (off `rcon.players_polled`), `player_flag` (off `player.connected`, flags resolved from the `players` row), and `time_of_day` (off any event, gated by a per-rule cooldown). The `chat_keyword` condition is evaluated in `@squad/worker-log-ingest` (chat is not on the event stream).
- Executes a match's action via the shared `runMatch`: `rcon_command`/`kick`/`warn` enqueue an operator command onto `rcon:commands:<serverId>` for worker-rcon; `notify_admin` is recorded (durable admin-facing history) and logged.
- Records every firing to `automation_runs` and `audit_log`. Rules are managed via `POST/PUT/DELETE /api/v1/automation-rules` and tested (without executing the action) via `POST /api/v1/automation-rules/:id/dry-run` — see [api.md](./api.md).

## What it does not do yet

- Does not load plugins from the filesystem or a package registry — only plugins compiled into `BUILTIN_PLUGINS` can run. A dynamic/filesystem plugin loader is a documented follow-up.
- Does not persist *plugin* enablement to Postgres — plugin registration is in-code (automation *rules*, by contrast, live in `automation_rules`).
- Does not deliver `notify_admin` over email/web-push — delivery is the `automation_runs` + `audit_log` record plus a warn-level log; wiring the AUTO-3 sink would require extracting it into a shared package (follow-up).

## Code location

```
apps/workers/automation/
  src/
    index.ts     — wires redis, plugin registry/loader, dispatch loop, heartbeat, graceful shutdown
    registry.ts   — PluginRegistry: manifest validation + per-kind subscriber index
    loader.ts     — loadPlugins() + BUILTIN_PLUGINS (empty)
    dispatch.ts   — Redis consumer-group loop, permission gate, timeout/error isolation, dedup, onEnvelope hook
    rules/
      runtime.ts  — AUTO-1: map an envelope → trigger input, evaluate rules, fire matches (time_of_day cooldown)
      deps.ts     — AUTO-1: load rules, resolve player flags, enqueue RCON, record run + audit
      engine.ts   — re-exports the pure evaluate() from @squad/shared-types
      actions.ts  — re-exports the pure runMatch() from @squad/shared-types
```

The pure engine (`evaluate`) and action executor (`runMatch`, with the dry-run guard) live in `@squad/shared-types` (`automation-engine.ts`/`automation-actions.ts`, alongside `cron5.ts`) so the worker and the dry-run API route share one implementation.

Shared plugin contract: `packages/shared-types/src/plugins.ts` (`pluginManifest`, `PLUGIN_PERMISSIONS`, `PluginHandler`, `hasPluginPermission`).

## Dependencies

- `pino` — structured logging
- `ioredis` — Redis client (`xadd`/`xreadgroup`/`xgroup`/`xack`/`scan`, consumer groups)
- `@squad/shared-config` — heartbeat helper
- `@squad/shared-types` — `EventEnvelope`, plugin manifest/permission schemas, AUTO-1 rule schemas + `evaluate`/`runMatch`
- `@squad/db` — `automation_rules`/`automation_runs`/`audit_log` access (AUTO-1)
- `drizzle-orm`, `uuid` — DB queries + id generation (AUTO-1)

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
