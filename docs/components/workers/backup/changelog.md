# Changelog — worker-backup

## 2026-07-29 — docs reconciliation (#216)

### Changed

- Rewrote `README.md`, `api.md`, `data-model.md`, `flows.md`, `configuration.md`, and `troubleshooting.md` to describe the worker's real, active `worker:heartbeat:backup` heartbeat lifecycle (published whenever `REDIS_URL` is set, TTL 30 s) instead of the retired "does not publish a heartbeat" P2-stub description — the heartbeat itself has been live since 2026-04-26 below, but the standard docs set had drifted and still described it as absent.
- Restic/domain backup logic (the actual scheduled snapshots, which run in the separate `backup` docker-compose service) remains explicitly documented as deferred; only the worker's own lifecycle description changed.
- Added `testing.md` subsections for `compose-backup.test.ts`, `fullstack-down-v.test.ts`, and `index-import.test.ts`, which were present under `test/` but missing from the docs.

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:backup` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.