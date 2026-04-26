# Changelog — worker-audit-archiver

## 2026-04-26

### Added

- Added `test/archive.test.ts`: stub behavior tests for `startHeartbeat` Redis interface.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P0 stub: heartbeat-only process. Archival logic deferred to Phase 1.
- Publishes `worker:heartbeat:audit-archiver` with `status: "idle (P1)"`.
- Graceful shutdown on SIGTERM/SIGINT.