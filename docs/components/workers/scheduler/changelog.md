# Changelog — worker-scheduler

## 2026-07-28 — boot no longer requires the host bridge (#229)

### Changed

- `src/index.ts` no longer dies when `PANEL_BRIDGE_SOCKET` is unreachable at
  startup. `await bridge.connect()` rejected straight into the top-level
  `catch`, so the process exited 1 before `startHeartbeat` ever published —
  the worker read as *dead* rather than *degraded*, and the five ticks that
  need no bridge (seed schedule, rotation schedule, map votes, season
  finalize) went down with it. The connect is still attempted eagerly for the
  log line, but a failure is now warned and swallowed; `BridgeClient` dials on
  demand, so the rotation-profile and scheduled-task ticks reconnect on their
  own. This matches `metrics-sampler` and `log-ingest`, which never connected
  at boot.

### Fixed

- `test/contract.test.ts` now passes `DATABASE_URL` (and `PANEL_BRIDGE_SOCKET`)
  through `envOverrides`, mirroring `log-ingest`. Without it the spawned worker
  exited 1 on `DATABASE_URL is required` before publishing a heartbeat, so both
  contract cases failed on any runner without an ambient `DATABASE_URL`.

## 2026-07-26

### Added

- GAME-1 (#80): map auto-selection tick. Servers with
  `server_settings.map_vote_enabled` get one `AdminSetNextLayer` per match,
  picked from the `map_vote_candidates` pool by the shared
  `selectNextLayer` rule (weighted-random / least-recently-played with
  layer/map cooldowns; seed rounds ignored), recorded in `map_vote_picks`
  (migration `0090`, unique per match) with a deterministic RCON request id
  `map-vote:<matchId>`. Depot-update windows are skipped and audited.
  `sendRconCommand` in `deps.ts` gained an optional `requestId` parameter.

## 2026-07-25

### Added

- MSG-4 (#187): `broadcast` scheduled tasks now rotate through
  `params.messages`, advancing the new `scheduled_tasks.rotation_index` cursor
  (migration `0086`) after each successful dispatch, and echo the resolved text
  into `chat_messages` (scope `broadcast`, source `panel`) authored by the task
  creator. A null creator skips the echo; an echo failure leaves the run
  `executed`. Added `advanceRotationIndex` / `echoBroadcastToChat` deps and
  scheduler-tick coverage for rotation, echo, and the no-author path.

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
