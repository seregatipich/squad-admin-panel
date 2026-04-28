# `diag` — configuration

The package has no environment variables of its own — it is purely a producer library. The Redis client and pino logger are injected by the consumer, which means all connection-level configuration (host, port, password, TLS) lives wherever that consumer instantiates them.

## Constants

These are baked into the package and exported for consumers that need to coordinate (the wipe endpoint, the flush worker, the bundle endpoint):

| Name | Value | Source | Why baked, not configurable |
|---|---|---|---|
| `DIAG_STREAM_KEY` | `'diag:queue'` | `packages/diag/src/types.ts` | The producer and the (yet-to-ship) consumer must agree on a single key. Multiple panels do not share a Redis instance, so per-environment differentiation is not needed. |
| `DIAG_STREAM_MAXLEN` | `100_000` | `packages/diag/src/types.ts` | Bounds Redis memory under flush-worker stalls. ~30 MiB at ~300 bytes/entry. If this needs tuning, change the constant in code — there is no runtime knob. |

Both constants are also re-exported from `@squad/shared-config` (`packages/shared-config/src/diag.ts`) so consumers that do not want to take a runtime dep on `@squad/diag` can still reach them.

## Environment variables (none owned)

`@squad/diag` reads zero environment variables. It uses what the caller injects.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| _(none)_ | — | — | — | — | — |

The Redis client passed to `createDiag` is configured by the **consumer's** env (typically `REDIS_URL` for `apps/api` and each worker; see those components' `configuration.md`). The pino logger is configured by the consumer's logging convention.

## Feature flags

None. Diagnostic emission is always on — there is no kill switch, by design (the bundle endpoint is unusable without continuous emission).

## Per-environment differences

None. The wire shape, stream key, and maxlen are identical across local, staging, and production. The pino fallback is always engaged so that a misconfigured Redis in any environment still leaves a paper trail.

## Configuration example

```ts
// At process boot, e.g. apps/api/src/server.ts (planned, Task 5):
import IORedis from 'ioredis';
import { pino } from 'pino';
import { createDiag } from '@squad/diag';

const redis = new IORedis(process.env.REDIS_URL!);
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const diag = createDiag({ redis, log });
app.decorate('diag', diag);
```

## Sensitive values

`emit()` does not log secrets, but **the caller controls `payload`**. The producer-side rule is the same as for `audit_log` and the event stream: never put RCON passwords, session cookies, JWTs, or PII into a `payload`. The bundle endpoint applies redaction over a known field list (see design spec §3.4), but that is a defence-in-depth — the primary defence is producers not putting secrets there in the first place.
