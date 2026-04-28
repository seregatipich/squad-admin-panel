# Changelog — worker-log-ingest

## 2026-04-28

### Added

- Wired `@squad/diag` into the worker (`createDiag({ redis, log })` constructed once at startup, threaded into `TailManager` and per-server `LogIngestor`).
- `tail.started` (info, per-server) emitted when the docker-logs-follow stream is opened.
- `tail.stopped` (info, per-server) emitted when the stream ends, with `payload.reason ∈ {'aborted','stream-end','stream-error'}` and an optional `error` field for the error path.
- `tails.changed` (info) emitted on net delta in the active tail set during `TailManager.reconcile()` — payload `{ added, removed, total }`. Unchanged reconciliation ticks emit nothing, mirroring the `worker-rcon` pattern.
- `parser_error` (warn, per-server) emitted when a `[`-prefixed line fails the prefix regex or a category handler throws. Payload includes `lineSample` (≤200 chars), `regex` name, and `errorMessage`.
- `squad.log.fatal` (fatal, per-server) emitted for every line matching `LogExit:`, `Fatal error:`, or `Assertion failed: … [File:… Line:…]`. Payload `{ ts, file, line, raw }` — `file`/`line` only populated for the assertion variant. No producer-side de-dupe; bundle render handles dedupe.
- `src/manager.ts` extracts the aborters-map / reconcile-delta logic into a small testable `TailManager` class, mirroring `RconSupervisor`.
- `LogIngestor` now accepts optional `onParseError` and `onSquadFatal` callbacks; the worker plumbs both into diag emits.
- `detectSquadFatal(line)` exported from `src/parser/patterns.ts`; runs before the prefix parser so assertion lines (no timestamp prefix) still surface.
- New unit tests:
  - `test/patterns.test.ts` — three Squad-fatal pattern fixtures + LogIngestor callback invocation count.
  - `test/manager.test.ts` — `TailManager.reconcile` net-delta correctness across add / remove / unchanged / swap, including the no-diag fallback.

### Changed

- `package.json` adds `@squad/diag: workspace:*` to `dependencies`.
- `index.ts` reconcile loop now delegates to `TailManager.reconcile(wanted)` instead of mutating an inline `aborters` Map.
- `tail.ts` exposes optional `onStarted` / `onStopped` callbacks; `onStopped` carries `{ reason, error? }`.

### References

- Spec: [`docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`](../../../superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) §3.2
- Plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 12

## 2026-04-26

### Added

- Added `test/ingest.test.ts`: player connect/disconnect flow tests (correlation window, player.disconnected, rcon.connected, unknown lines).
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- Initial implementation: `tailContainerLogs`, `LogIngestor`, `publish` with dedup.
- Log line prefix parser (`parseLine`) handling all Squad UE4 log categories.
- Benign noise filter for known high-volume non-event lines.
- Event types: `server.ready`, `server.stopped`, `server.crashed`, `player.connected`, `player.disconnected`, `match.started`, `match.ended`.
- Player-connect correlation: `Join succeeded` + `EOS Connection` within 2500 ms window.
- Reconcile loop: attaches/detaches tails as server status changes every 15 s.
- Heartbeat: `worker:heartbeat:log-ingest` every 5 s.
- Unit tests: log line parser, `LogIngestor` event extraction, noise filter.