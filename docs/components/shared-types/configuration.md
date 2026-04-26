# `shared-types` — configuration

`@squad/shared-types` contains only Zod schemas and derived TypeScript types. It has no environment variables and no runtime configuration surface.

## Sub-path exports

| Export path | Contents |
|---|---|
| `@squad/shared-types` | Full barrel — all schemas and types |
| `@squad/shared-types/events` | `EventEnvelope`, `EVENT_TYPES`, payload schemas, stream/consumer group constants |
| `@squad/shared-types/api` | `serverCreateInput`, `serverRow`, `playerRow`, `auditEntry`, `paginated`, host schemas |

Both sub-paths are browser-safe (no Node.js built-in imports).

## Zod version dependency

The package depends on `zod ^3.24.0`. Consumers that also use Zod must use a compatible version; mismatched Zod instances cause `instanceof ZodError` checks to fail.

## Schema version

`EventEnvelope.version` starts at `1`. Incrementing it on breaking payload changes allows consumers to upcast old messages. See the upcasting section in [`data-model.md`](data-model.md#upcasting-when-version-changes).

## No feature flags or environment-specific behaviour

All schema shapes are invariant across environments. Validation stringency (`.strict()`) is identical in development, CI, and production.
