# Changelog — worker-metrics-sampler

## 2026-04-29

### Added

- Emits diagnostic events to `diag:queue` (`@squad/diag`):
  - `metrics_sampler.started` (info) — right after `startHeartbeat` at startup.
  - `metrics_sampler.stopped` (info) — inside the SIGTERM/SIGINT handler before `process.exit`.
- Per-cycle `run_ok`/`run_failed` are intentionally not emitted — 15 s cadence would be too noisy.
- New `src/lifecycle.ts` exports `emitStarted(diag)` and `emitStopped(diag, sig)` so the lifecycle emits are unit-testable.
- `test/diag-lifecycle.test.ts` covers both helpers.
- Added `@squad/diag` workspace dependency.

## 2026-04-26

### Added

- Added `test/maxlen.test.ts`: MAXLEN enforcement test verifying `MAXLEN ~ HOST_METRICS_MAXLEN` on every xadd call.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- Initial implementation: `runSampler` with 15 s interval, `XADD host:metrics MAXLEN ~ 5760`.
- `packHostMetrics` encoding: 8-integer tuple with `x100` for percentages and load averages.
- Pino multistream: stdout + `panel:logs` Redis sink.
- Heartbeat: `worker:heartbeat:metrics-sampler` every 5 s.
- Bridge error isolation: `warn` log on failure, sampling continues on next tick.
- Unit tests: tick count, packed array encoding, error resilience.

### Notes

- `user: "0:${PANEL_GID:-987}"` required in compose — primary GID `panel` for bridge `SO_PEERCRED` auth. `group_add: panel` is insufficient.