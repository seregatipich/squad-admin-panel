# Changelog

## 2026-04-28

### Added

- Initial `@squad/diag` package (Phase A1, Task 3 of the diagnostic-bundle plan).
- `createDiag({ redis, log })` factory exporting `Diag.emit(ev)`.
- `DiagEvent`, `DiagSeverity`, `Diag`, `DiagDeps` types.
- Constants `DIAG_STREAM_KEY = 'diag:queue'` and `DIAG_STREAM_MAXLEN = 100_000`.
- Vitest unit suite: XADD wire-shape assertion + pino-fallback assertion.
- `DIAG_STREAM_KEY` / `DIAG_STREAM_MAXLEN` re-exported from `@squad/shared-config` for consumers that do not want a runtime dep on `@squad/diag` (the wipe endpoint, `worker-diag-flush`).

### Changed

- `packages/shared-config/src/index.ts` now re-exports `./diag.js` alongside the existing barrel entries.

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
