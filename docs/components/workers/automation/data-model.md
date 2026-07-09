# worker-automation — Data model

No Postgres tables. Plugin registration is entirely in-code (`BUILTIN_PLUGINS` in `src/loader.ts`) for this pass — persisting plugin enablement to a `plugins` table was explicitly optional for `INT-4` and has not been added.

## Redis keys read/written

| Key pattern | Direction | Purpose |
|---|---|---|
| `events:global` | read | Shared stream for events with no `server_id` |
| `events:server:<id>` | read | Per-server event stream (discovered via `SCAN events:server:*`) |
| `dedup:automation-dispatch:v1:<event_id>` | read/write | Consumer-side idempotency: an entry already claimed here is ack'd without re-dispatching |
| `worker:heartbeat:automation` | write | Liveness heartbeat (`@squad/shared-config`'s `startHeartbeat`) |

The `EventEnvelope` shape consumed from those streams is defined once in `packages/shared-types/src/events.ts` (`EVT-1`); the plugin manifest/permission contract is defined in `packages/shared-types/src/plugins.ts`.
