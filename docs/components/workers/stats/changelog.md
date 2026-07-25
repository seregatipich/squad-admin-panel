# Changelog — worker-stats

## 2026-07-25

### Changed

- DOSSIER-2 (#189): the dossier reconcile tick now runs **nightly** (was every 6 h)
  and inspects only the **last 48 h** of `combat_events`
  (`reconcileDossierAggregates(sql, { windowHours: 48 })`) instead of a full-table
  pass. Still report-only; the `dossier_reconcile.{run_ok,drift_detected,run_failed}`
  diagnostics and their payloads are unchanged.
- Rewrote the component docs (README, data-model, flows, configuration,
  troubleshooting, testing) to describe the reconcile guard — they previously still
  described the retired P2 stub.

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:stats` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.