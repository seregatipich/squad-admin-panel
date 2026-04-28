# Changelog

## 2026-04-28

### Added

- Initial `@squad/diag` package (Phase A1, Task 3 of the diagnostic-bundle plan).
- `createDiag({ redis, log })` factory exporting `Diag.emit(ev)`.
- `DiagEvent`, `DiagSeverity`, `Diag`, `DiagDeps` types.
- Constants `DIAG_STREAM_KEY = 'diag:queue'` and `DIAG_STREAM_MAXLEN = 100_000`.
- Vitest unit suite: XADD wire-shape assertion + pino-fallback assertion.
- `DIAG_STREAM_KEY` / `DIAG_STREAM_MAXLEN` re-exported from `@squad/shared-config` for consumers that do not want a runtime dep on `@squad/diag` (the wipe endpoint, `worker-diag-flush`).
- Consumer `worker-diag-flush` shipped (Task 4 of the same plan); see [`docs/components/workers/worker-diag-flush/`](../workers/worker-diag-flush/README.md). It reads `diag:queue` with `XREADGROUP` and batches into `diagnostic_events`. The producer side of `@squad/diag` is unchanged by Task 4.
- API consumes `@squad/diag` via `app.diag` and per-request `req.diag` decorations (Task 6); the request id is auto-injected into every emit by an `onRequest` hook unless the caller already set `requestId`. See [`docs/components/api/api.md`](../api/api.md#decorations) and [`docs/components/api/flows.md`](../api/flows.md#diagnostic-emission). The producer side of `@squad/diag` is unchanged by Task 6.
- API server-lifecycle routes (install / start / stop / soft-delete / restore) now produce structured `server.*` events into `diag:queue` (Task 7). Per-route event ordering and payload contracts live in [`docs/components/api/api.md`](../api/api.md) (lifecycle event kinds table) and [`docs/components/api/flows.md`](../api/flows.md#lifecycle-event-sequences). The `@squad/diag` package itself is unchanged by Task 7.
- API status reconciler now produces `container.exited` / `container.unexpected_exit` / `server.stop.reconciler_confirmed` events into `diag:queue` on every observed `running → stopped` transition (Task 8). The reconciler distinguishes a planned exit from a crash by reading the Redis fence `stop:requested:{server_id}` set by the stop handler. Payload contract: `{ exit_code, oom_killed, signal, finished_at, started_at }`. See [`docs/components/api/api.md`](../api/api.md#lifecycle-event-kinds-emitted-by-the-status-reconciler) and [`docs/components/api/flows.md`](../api/flows.md#reconciler-container-exit-observation-background-every-4-s). The `@squad/diag` package itself is unchanged by Task 8.

### Changed

- `packages/shared-config/src/index.ts` now re-exports `./diag.js` alongside the existing barrel entries.
- `packages/diag/package.json` now follows the workspace convention used by `@squad/shared-config`: `exports` map with `types` / `development` / `default` conditions pointing at `./dist/*.{d.ts,js}` for production and `./src/*.ts` for dev/test runs (plus a `./types` subpath and `./package.json` passthrough). Replaces the legacy `main`/`types` form that pointed straight at TS source — the api/worker Docker images consume from `dist/` and would have broken at runtime otherwise.
- `ioredis` and `pino` moved from `dependencies` to `devDependencies`. Both are imported via `import type` only (`Pick<Redis, 'xadd'>`, `Pick<Logger, 'warn' | 'debug'>`) so consumers bring their own client; `@squad/diag` no longer re-pins their major versions. `uuid` stays in `dependencies` because it is used at runtime via `v7 as uuidv7`.
- Rotation of `diagnostic_events` partitions moved from migration bootstrap (`0017_diagnostic_events.sql` seeds yesterday + today + 23 future days exactly once) to active management by `worker-event-partition` (`ensureDiagPartitions(sql)`, hourly tick). The migration's bootstrap is still load-bearing — it ensures today's partition exists before the worker has had a chance to run — but the long-term rotation now lives in the worker. See [`docs/components/workers/event-partition/`](../workers/event-partition/README.md). Retention is **24h** (any partition whose entire range is more than 24h in the past is dropped).

### Fixed

- _None._

### Removed

- _None._

### Migration notes

- No DB migration in this change. The `diagnostic_events` partitioned table was added in migration `0017_diagnostic_events.sql` (commit `d68fb21`) and the Drizzle schema in commit `d7f994a`; this package is the producer half.
- No breaking changes — the package is brand-new and not yet imported by any production code path. Consumers (api, workers) will be wired up in subsequent tasks.

### References

- Spec: [`docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`](../../superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) §3.2
- Plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 3
