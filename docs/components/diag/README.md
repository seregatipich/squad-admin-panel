# `diag` — panel-internal diagnostic event emitter

Tiny TypeScript package (`@squad/diag`) that lets every Node-side panel component (api, workers) push structured diagnostic events into a Redis Stream (`diag:queue`). A separate consumer worker (`worker-diag-flush`, shipped in a follow-up task) batches the stream into the `diagnostic_events` Postgres partitioned table; this package is the producer half only.

## Why it exists

The diagnostic-bundle endpoint (`GET /api/v1/host/diagnostics/bundle`) needs a panel-wide, queryable, time-bounded record of "what was the panel doing" — server lifecycle steps, reconciler decisions, RCON state changes, WS connect/disconnect, db/redis ping failures. `pino` logs alone are not queryable, can be split across files, and rotate. `audit_log` is for human-actor decisions, not internal state changes, and its append-only hash chain would be too expensive for high-volume diagnostics.

`@squad/diag` is therefore a thin write path: producers do not need to know how the rows reach Postgres or what the bundle endpoint will do with them — they call `emit()`, and either the row reaches Redis or it falls back to `pino.warn` so it is not silently lost.

## What it does NOT do

- **Does not write to Postgres.** Inserts are the consumer's responsibility (`worker-diag-flush`, separate package).
- **Does not own the Postgres schema.** `diagnostic_events` is owned by the [`db`](../db/README.md) component; see migration `0017_diagnostic_events.sql`.
- **Does not throw on Redis failure.** The `emit()` contract is fire-and-best-effort: callers must NOT wrap it in try/catch, must NOT await it on the request critical path. A failure falls back to `pino.warn`.
- **Does not deduplicate, aggregate, or rate-limit.** The bundle endpoint's section §2 dedupes; producers should not.
- **Does not mirror to pino at the same severity in this package.** That's a planned design choice (see spec §3.2) but is intentionally NOT implemented here — only the warn fallback is. If we add severity-mirroring it goes in a follow-up.
- **Does not replace `audit_log`.** Use `audit_log` for human-actor mutations; use `diag` for internal panel state.

## Code location

- [`packages/diag/src/index.ts`](../../../packages/diag/src/index.ts) — `createDiag({ redis, log })` factory.
- [`packages/diag/src/types.ts`](../../../packages/diag/src/types.ts) — `DiagEvent`, `DiagSeverity`, `DIAG_STREAM_KEY`, `DIAG_STREAM_MAXLEN`.
- [`packages/diag/test/emit.test.ts`](../../../packages/diag/test/emit.test.ts) — unit tests (XADD shape + pino fallback).

`DIAG_STREAM_KEY` and `DIAG_STREAM_MAXLEN` are also re-exported from [`@squad/shared-config`](../shared-config/README.md) (`packages/shared-config/src/diag.ts`) so consumers that only need the key (the wipe endpoint, the flush worker) do not have to take a runtime dep on `@squad/diag`.

## Dependencies

| Direction | Package | Why |
|---|---|---|
| Depends on | `ioredis` | `XADD` to `diag:queue` |
| Depends on | `pino` | Type-only; the `Logger` is injected by the consumer |
| Depends on | `uuid` | UUIDv7 for the per-event id |
| Used by (planned) | `@squad/api` | per-request `Diag` decorator |
| Used by (planned) | every `@squad/worker-*` | startup + per-tick instrumentation |
| Used by (planned) | `@squad/worker-diag-flush` | imports types only; consumes via `XREADGROUP` |

## Basic usage

```ts
import IORedis from 'ioredis';
import { pino } from 'pino';
import { createDiag } from '@squad/diag';

const redis = new IORedis(process.env.REDIS_URL!);
const log = pino();
const diag = createDiag({ redis, log });

await diag.emit({
  component: 'api',
  kind: 'server.start.requested',
  severity: 'info',
  serverId: '019dbaa5-...',
  actorSteamId64: '76561198000000000',
  requestId: req.id,
  message: 'manual start via REST',
  payload: { reason: 'manual' },
});
```

## Related docs

- [`api.md`](api.md) — `createDiag`, `emit`, types
- [`data-model.md`](data-model.md) — Redis Stream entry shape; partitioned Postgres table is documented in [`db/data-model.md`](../db/data-model.md)
- [`flows.md`](flows.md) — happy path + Redis-failure fallback
- [`configuration.md`](configuration.md) — env vars and constants
- [`testing.md`](testing.md) — vitest layout
- [`troubleshooting.md`](troubleshooting.md) — what to check when events are missing
- [`changelog.md`](changelog.md) — meaningful changes

## Cross-references

- Design spec: [`docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`](../../superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) §3.2
- Implementation plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 3
