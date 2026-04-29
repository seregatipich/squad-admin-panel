# worker-diag-flush — Testing

## Test files

| Path | Tier | What it covers | What it does NOT cover |
|---|---|---|---|
| [`apps/workers/diag-flush/test/contract.test.ts`](../../../../apps/workers/diag-flush/test/contract.test.ts) | Unit (Tier 1) | `flushBatch()` parses XREAD entries, builds the INSERT shape, ACKs both valid and malformed entries, and short-circuits on empty input. | The main `XREADGROUP` loop, the consumer-group creation, the heartbeat publisher, the SIGTERM handler. |
| [`apps/workers/diag-flush/test/diag-lifecycle.test.ts`](../../../../apps/workers/diag-flush/test/diag-lifecycle.test.ts) | Unit (Tier 1) | `emitStarted` / `emitStopped` produce the expected `diag.emit` payloads. | The full `main()` boot sequence — these helpers are exported for unit-testability. |
| [`apps/workers/diag-flush/test/journald.test.ts`](../../../../apps/workers/diag-flush/test/journald.test.ts) | Unit (Tier 1) | `parseJournaldLine` (8 cases), `handleJournaldLine` (3 cases), and `startJournaldForwarder.drain()` (2 cases). The drain cases use a fake child (a `node:events.EventEmitter` with `stdout`/`stderr` sub-emitters and a stubbed `kill`) injected via `spawnFn`, plus a controllable slow `xadd` to assert `drain()` does NOT resolve while a handler is pending and DOES resolve once the handler finishes. | The `journalctl` subprocess itself — not spawned in unit tests. End-to-end coverage requires a live `panel-host-bridge` journal. |

## How to run

```sh
pnpm --filter @squad/worker-diag-flush test
```

No infrastructure required — the suite mocks `sql.unsafe` and `redis.xack` with `vi.fn()`. Total runtime ~300 ms.

## Test cases

### `parses XREAD entries and inserts in one batch, then ACKs`

Asserts the happy path with a single well-formed entry:

- Exactly one call to `sql.unsafe`.
- The SQL text starts with `INSERT INTO diagnostic_events`.
- The SQL text contains `ON CONFLICT (id, ts) DO NOTHING`.
- `args[0]` (the `id` placeholder) equals the entry's `id` field.
- `redis.xack('diag:queue', 'g', '1700-0')` is called.

### `skips malformed entries but ACKs them so they do not block the stream`

Asserts the poison-pill drop:

- The entry has bogus fields (`['not-a-valid-key', 'value']`).
- `sql.unsafe` is NOT called (no valid rows → no INSERT).
- `redis.xack('diag:queue', 'g', '1700-0')` IS called — the entry is acknowledged so it leaves `pending` and stops blocking the consumer.

### `inserts valid rows and still ACKs malformed ones in the same batch`

Asserts mixed batches: one malformed entry plus one valid entry containing all optional fields (`server_id`, `request_id`, `payload` with content):

- One INSERT with placeholders matching the multi-row pattern (`VALUES ($1,$2::timestamptz,...)`).
- The args array has exactly 10 items (one row × 10 columns).
- `xack` is called with both stream ids: `('diag:queue', 'g', '1700-0', '1700-1')`.

### `returns immediately when entries is empty`

Asserts the no-op short-circuit:

- Empty `entries` → no `sql.unsafe`, no `xack`.

## Mocks and fakes

The tests use a `makeSql()` factory that returns:

```ts
{
  sql: <a function-callable object with an `.unsafe` property>,
  unsafe: vi.fn(async () => undefined),
}
```

This matches the `postgres.Sql` shape closely enough for `flushBatch`'s usage (`sql.unsafe(text, args)`) without instantiating a real driver.

The Redis fake is `{ xack: vi.fn().mockResolvedValue(N) }` — only the `xack` method is exercised in the unit suite. The consumer-group setup, blocking read, and heartbeat all live inside `main()`, which is gated behind `process.env.VITEST !== 'true'` so `import` does not trigger it.

## What is NOT tested at the unit tier

- The main `while (!stopped)` loop — covered (planned) by an end-to-end smoke that runs against a real Redis/Postgres pair in Phase A2 of the plan.
- The `XGROUP CREATE ... MKSTREAM` idempotency on `BUSYGROUP` — empirically validated; the unit-test environment doesn't pretend to be Redis.
- The heartbeat publisher — `@squad/shared-config` owns its own tests for `startHeartbeat`.
- The SIGTERM exit-0 contract — covered by the canonical contract test pattern in other workers; not yet replicated here because the worker is brand-new and lacks an integration-test infrastructure entry. The pattern is the same as `apps/workers/audit-archiver/test/contract.test.ts` and can be lifted once the host has a dedicated test Redis (`redis://127.0.0.1:6379/14`).

## Edge cases the unit tests guard

| Edge case | Guard |
|---|---|
| Producer omits `payload` field entirely | `parseEntry` defaults to `'{}'` |
| Producer sends `payload` with empty string | Treated as missing; `parseEntry` defaults to `'{}'` |
| Required field missing | `parseEntry` returns `null`; entry is dropped+ACKed |
| Multi-row INSERT placeholder math | Asserted via the `VALUES \(\$1,\$2::timestamptz,` regex match |
| Empty XREAD result | Short-circuit before any I/O |

## Adding new tests

When a new field is added to `DiagEvent`:

1. Update `parseEntry` to read the new key and add it to the row tuple.
2. Update the SQL placeholders count and the args list.
3. Add a unit-test case asserting the new field round-trips through `flushBatch` into `args`.

When a new error mode is added (e.g. retry on `ECONNRESET`):

1. Add a vi-mocked rejection on `sql.unsafe` or `redis.xack`.
2. Assert the new behaviour (logged, retried, etc).
