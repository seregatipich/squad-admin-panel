# Changelog — worker-stats

## 2026-07-29 — docs reconciliation (#216)

### Changed

- Rewrote `api.md` — the one file the 2026-07-25 doc rewrite below missed. It still
  described a "P2 stub" with no public surface and a planned `stats:v1` consumer
  group; it now documents the real `worker:heartbeat:stats` heartbeat key and the
  `dossier_reconcile.{run_ok,drift_detected,run_failed}` diagnostic events emitted
  by the reconcile guard, and notes that `CONSUMER_GROUP.stats` (`'stats:v1'`) is
  unused by this worker.
- `README.md`, `data-model.md`, `flows.md`, `configuration.md`, `troubleshooting.md`,
  and `testing.md` were already accurate as of 2026-07-25 and are unchanged.

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