# Changelog — worker-audit-archiver

## 2026-04-29

### Added

- Emits diagnostic events to `diag:queue` (`@squad/diag`):
  - `audit_archiver.started` (info) — right after `startHeartbeat` at startup.
  - `audit_archiver.run_ok` / `audit_archiver.run_failed` (info / error) — per hourly cycle.
  - `audit_archiver.stopped` (info) — inside the SIGTERM/SIGINT handler before `process.exit`.
- New `runArchiverCycle({ diag })` exported from `src/index.ts` so the per-cycle emits are unit-testable.
- Added `test/diag-lifecycle.test.ts` asserting `audit_archiver.run_ok` is emitted on a successful cycle.
- Added `@squad/diag` workspace dependency.

### Changed

- Replaced the `process.env.VITEST !== 'true'` guard around `main()` with a `realpathSync` entrypoint check (matches the other workers) so the spawned subprocess in the contract test still boots even when `VITEST=true` leaks into the env.

## 2026-04-26

### Added

- Added `test/archive.test.ts`: stub behavior tests for `startHeartbeat` Redis interface.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P0 stub: heartbeat-only process. Archival logic deferred to Phase 1.
- Publishes `worker:heartbeat:audit-archiver` with `status: "idle (P1)"`.
- Graceful shutdown on SIGTERM/SIGINT.