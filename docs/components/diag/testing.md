# `diag` — testing

The package is small enough that everything fits in Tier 1 (unit tests with fakes). The end-to-end coverage that proves Redis actually receives the entry, that `worker-diag-flush` flushes it, and that the bundle endpoint reads it back lives in the consumer/api packages — out of scope here.

## Test locations

| File | Tier | Covers |
|---|---|---|
| [`packages/diag/test/emit.test.ts`](../../../packages/diag/test/emit.test.ts) | 1 (unit) | `createDiag` factory, `emit` happy path, `emit` Redis-failure fallback. |

## How to run

```bash
# Single package:
pnpm --filter @squad/diag test

# Single test file:
pnpm --filter @squad/diag exec vitest run test/emit.test.ts

# Workspace-wide (this package is included automatically):
pnpm turbo run test
```

Typecheck:

```bash
pnpm --filter @squad/diag typecheck
# or
pnpm turbo run typecheck --filter @squad/diag
```

## What the tests cover

### `XADDs the event to diag:queue with all fields serialized`

- Calls `createDiag({ redis: { xadd }, log })` with a `vi.fn()` for `xadd` and `warn` + `debug`.
- Calls `emit` with a fully populated `DiagEvent` (component, kind, severity, serverId, message, payload).
- Asserts `xadd` is called once.
- Asserts the first arg is the literal `'diag:queue'` (the constant).
- Asserts the args contain `'MAXLEN'`.
- Walks the field/value pairs after `*` into a `Record<string, string>` and asserts:
  - `component === 'api'`
  - `kind === 'server.start.requested'`
  - `JSON.parse(payload)` equals the original payload object.

This proves the wire format is correct, the constant is used, and `JSON.stringify` is applied to `payload`.

### `falls back to pino.warn when Redis throws`

- Calls `createDiag` with an `xadd` mock that rejects with `new Error('NOREDIS')`.
- Calls `emit` with a minimal `DiagEvent`.
- Asserts `log.warn` was called.
- Asserts the first warn argument has `diag_event.kind === 'x'` (the event was passed through to the fallback).
- Implicitly asserts `emit` did NOT throw — the test would fail with an unhandled rejection otherwise.

This proves the fallback contract: Redis failures do not propagate to the caller, and the pino warn line carries enough information to reconstruct the missed event.

## What is explicitly NOT covered here

| Concern | Where it lives |
|---|---|
| Real Redis `XADD` actually persists the entry | Consumer integration test (`worker-diag-flush`, Task 4). |
| `worker-diag-flush` batches into Postgres correctly | `apps/workers/diag-flush/test/contract.test.ts` (Task 4). |
| Bundle endpoint reads `diagnostic_events` and renders Markdown | `apps/api/test/diagnostics-bundle.test.ts` (later task). |
| Wipe endpoint truncates partitions and `XTRIM`s the stream | `apps/api/test/diagnostics-wipe.test.ts` (later task). |
| `audit_log` rows fan out into `diagnostic_events` via `kind:'audit'` | `apps/api/test/audit-fanout.test.ts` (later task). |
| Per-request `requestId` propagation through Fastify | `apps/api/test/diag-decorator.test.ts` (Task 5). |

The producer-side library does not need a Tier 2 or Tier 3 test of its own — it has no I/O surface beyond `xadd`, and the contract test against a real Redis is the consumer's concern.

## Mocks and stubs

Both tests use `vi.fn()` against `Pick<Redis, 'xadd'>` and `Pick<Logger, 'warn' | 'debug'>`. No `ioredis-mock` or actual Redis is needed — the type contract is narrow enough that two stubs cover the surface.

## Test data sources

Inline literals in the test file. There are no fixtures.

## Important edge cases the tests guard

- Stream key is the registered constant, not a hard-coded string drift.
- `MAXLEN` is sent on every `XADD` (not only on first).
- `payload` is JSON-serialized (so the consumer can `payload::jsonb` cast in Postgres).
- Missing optional fields (`serverId`, `actorSteamId64`, `requestId`) do NOT appear as empty strings in the XADD args — see the second test's minimal event (no `serverId`) which exercises the fallback path; the first test exercises the all-fields path.
- Redis failure is swallowed and surfaced via `log.warn`, not via a thrown error.
