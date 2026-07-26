# Changelog — worker-scheduler

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
