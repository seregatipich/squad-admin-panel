# Changelog — worker-scheduler

## 2026-07-14

### Added

- Added ROT-4 one-off rotation schedule execution with depot-window handling,
  worker-rcon command queuing, and audit logging.
- Added weekly server-local rotation profiles with configurable default apply
  hour and ROT-2 managed-segment writes through the host bridge.
- Added API integration and scheduler tick coverage for the new behavior.

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:scheduler` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.
