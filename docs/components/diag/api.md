# `diag` — API

Public surface of `@squad/diag`. The package exposes one factory, two interface types, and a value object describing each event. There are no HTTP/RPC/CLI surfaces — diagnostic events are produced via the in-process function call below.

## `createDiag(deps)` — factory

```ts
import { createDiag, type Diag, type DiagDeps } from '@squad/diag';

function createDiag(deps: DiagDeps): Diag;
```

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `deps.redis` | `Pick<Redis, 'xadd'>` | yes | An `ioredis` client (or any object exposing the same `xadd` overload). Only `xadd` is used; consumers can pass a narrowed mock in tests. |
| `deps.log` | `Pick<Logger, 'warn' \| 'debug'>` | yes | A `pino` logger (or compatible). `warn` is called when Redis throws; `debug` is called on success when the consumer has it enabled. |

### Returns

A `Diag` object with a single method:

```ts
interface Diag {
  emit(ev: DiagEvent): Promise<void>;
}
```

### Errors

`createDiag` itself never throws — it returns synchronously. See `emit` below for the error contract.

### Side effects

None at construction time; the function is a thin closure over the dependencies.

### Example

```ts
const diag = createDiag({ redis, log: app.log });
```

---

## `diag.emit(ev)` — write one event

```ts
async emit(ev: DiagEvent): Promise<void>
```

### Parameters

`DiagEvent` shape:

| Field | Type | Required | Notes |
|---|---|---|---|
| `component` | `string` | yes | Producer name, free-form but should match the registered set (`api`, `reconciler`, `worker-rcon`, `worker-log-ingest`, `worker-audit-archiver`, `worker-event-partition`, `panel-host-bridge`, `db`, `redis`). |
| `kind` | `string` | yes | Dotted-path event kind, e.g. `server.start.requested`, `rcon.connected`, `pg.ping.fail`. The full registered set lives in the design spec §3.3. |
| `severity` | `'info' \| 'warn' \| 'error' \| 'fatal'` | yes | Surfaces in the bundle's §2 grouping. |
| `serverId` | `string` (UUIDv7) | no | When the event is scoped to a Squad server. |
| `actorSteamId64` | `string` | no | When a human action triggered the event (mirrors `audit_log.actor_id`). |
| `requestId` | `string` | no | Fastify per-request id when emitted from an HTTP handler. |
| `message` | `string` | yes | Short human-readable line — appears in bundle §2/§4. |
| `payload` | `Record<string, unknown>` | no | Structured detail; default `{}`. JSON-serialized into the stream entry. |

### Returns

A `Promise<void>` that resolves once Redis acknowledges the `XADD` (or once the pino fallback has been called on failure). Never rejects.

### Errors

The contract is **fire-and-best-effort**:

- A successful `XADD` returns the new stream entry id (ignored by the caller) and `emit()` resolves.
- If `xadd` rejects (Redis down, network blip, AUTH error), `emit()` catches the error, calls `log.warn({ diag_event, err }, 'diag emit failed; using pino fallback')`, and resolves. **`emit()` does NOT throw.** This is intentional: producers must not have to wrap diagnostic emission in their own try/catch, and the request critical path must not be coupled to Redis liveness.

### Side effects

- Performs `XADD diag:queue MAXLEN ~ 100000 * id <uuidv7> ts <iso> component <…> severity <…> kind <…> [server_id <…>] [actor_steam_id64 <…>] [request_id <…>] message <…> payload <json>`.
- On successful XADD, calls `log.debug({ diag_event: { id, ...ev } }, 'diag emitted')` (if debug is enabled by the consumer).
- On failure, calls `log.warn({ diag_event: { id, ts, ...ev }, err }, 'diag emit failed; using pino fallback')`.
- Generates one UUIDv7 per call (`uuid` package, `v7` export).
- Computes one ISO timestamp per call (`new Date().toISOString()`).
- The optional fields (`serverId`, `actorSteamId64`, `requestId`) are omitted from the stream entry when undefined; they are NOT written as empty strings, so the consumer can treat absence as `NULL`.

### Example

```ts
await diag.emit({
  component: 'reconciler',
  kind: 'container.unexpected_exit',
  severity: 'error',
  serverId: server.id,
  message: 'container exited without preceding stop request',
  payload: { exit_code: inspect.State.ExitCode, oom_killed: inspect.State.OOMKilled },
});
```

---

## Constants

Re-exported from `./types.js` and (for consumers that only need the key) from `@squad/shared-config`:

| Name | Value | Meaning |
|---|---|---|
| `DIAG_STREAM_KEY` | `'diag:queue'` | Redis Stream key that `emit` writes to and that `worker-diag-flush` reads from. |
| `DIAG_STREAM_MAXLEN` | `100_000` | Approximate cap (`~`) for the stream length, applied on every `XADD`. |

## Types

```ts
export type DiagSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface DiagEvent {
  component: string;
  kind: string;
  severity: DiagSeverity;
  serverId?: string;
  actorSteamId64?: string;
  requestId?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface DiagDeps {
  redis: Pick<Redis, 'xadd'>;
  log: Pick<Logger, 'warn' | 'debug'>;
}

export interface Diag {
  emit(ev: DiagEvent): Promise<void>;
}
```
