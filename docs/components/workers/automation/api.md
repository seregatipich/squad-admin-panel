# worker-automation — API surface

No HTTP surface of its own. AUTO-1 (#72) rules are **managed** over HTTP by the API service (`apps/api/src/routes/automation-rules.ts`), and this worker consumes them:

| Endpoint (in `@squad/api`) | Purpose |
|---|---|
| `GET/POST /api/v1/automation-rules`, `PUT/DELETE /api/v1/automation-rules/:id` | CRUD for rules (gated on `role:edit`; every mutation audited) |
| `POST /api/v1/automation-rules/:id/dry-run` | Evaluate a rule against a sample **without executing the action**; persists an `automation_runs` row with `dry_run=true` |
| `GET /api/v1/automation-runs` | Firing history (real firings + dry-runs) |

The worker loads the enabled rules from `automation_rules` and evaluates them per event (see [flows.md](./flows.md)). The pure `evaluate`/`runMatch` shared with the dry-run route live in `@squad/shared-types`.

## Plugin host contract (INT-4)

The worker also hosts the in-process plugin contract, defined in `packages/shared-types/src/plugins.ts`:

## `pluginManifest` (Zod schema)

```ts
{
  id: string;                       // lowercase kebab-case slug, 2-64 chars
  name: string;                     // 1-128 chars
  version: string;                  // 1-32 chars
  subscribedEventKinds: EventType[]; // non-empty, must be a known EVENT_TYPES value
  requestedPermissions: PluginPermission[]; // subset of PLUGIN_PERMISSIONS
}
```

Validated by `PluginRegistry.register` at registration time — an invalid manifest throws immediately rather than silently registering a broken plugin.

## `PluginHandler` (TS interface)

```ts
interface PluginHandler {
  onEvent(envelope: EventEnvelope): void | Promise<void>;
}
```

Invoked once per matching event by the dispatcher (`src/dispatch.ts`), wrapped in a try/catch and a per-invocation timeout (`DEFAULT_PLUGIN_TIMEOUT_MS`, 5s). A handler must not assume it will run to completion or that it runs before/after any other plugin's handler for the same event.

## `PLUGIN_PERMISSIONS`

| Permission | Effect if absent |
|---|---|
| `events:read` | The plugin is never dispatched to — the dispatcher counts it as `deniedPermission` and logs a warning. |
| `events:payload` | The plugin is still dispatched to, but receives a copy of the envelope with `payload` replaced by `null`. |

## Registering a plugin

Plugins are compiled directly into `apps/workers/automation/src/loader.ts`'s `BUILTIN_PLUGINS` array (see `loadPlugins(registry, plugins)`). There is no filesystem or dynamic loader in this pass — see the [README](./README.md) for the follow-up note.
