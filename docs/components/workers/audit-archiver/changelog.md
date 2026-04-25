# Changelog — worker-audit-archiver

## 2026-04-25

### Added

- P0 stub: heartbeat-only process. Archival logic deferred to Phase 1.
- Publishes `worker:heartbeat:audit-archiver` with `status: "idle (P1)"`.
- Graceful shutdown on SIGTERM/SIGINT.
