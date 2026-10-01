# Changelog — worker-scheduler

## 2026-10-01 — `deps.ts` split by dependency family (B3)

### Changed

- The dependency wiring moved unchanged from `src/deps.ts` into `src/deps/` (shared helpers plus one module per tick). `src/deps.ts` re-exports every module, so all existing imports and the exported names are the same.

## 2026-09-30 — season finalisation recomputes the slice first

### Fixed

- [#78](https://github.com/seregatipich/squad-admin-panel/issues/78) (finding 1110):
  `seasons.ends_at` is now one thing everywhere, an **exclusive instant**
  (the UI already labels it "не включительно"). `loadActiveSeasonTarget`
  derives `toDay` from `ends_at - 1 ms`, so a midnight `ends_at` no longer
  counts a day the season is already frozen for. The finalizer waits
  `SEASON_FINALIZE_GRACE_MS` (15 min) after `ends_at` so presence-daily can
  close the last day, then runs `recomputeSeasonSlice` once more before
  flipping `finalized`; a failed recompute leaves the season active and
  retried. Tests: `test/season-finalize-tick.test.ts`,
  `test/audit-and-finalize.integration.test.ts`,
  `packages/db/test/seasons.test.ts`. Decision: exclusive instant rather than
  inclusive day, because the scheduler, the `seasons_bounds_chk` constraint
  and the UI label already treat it that way; an inclusive day would need a
  stored-data migration.

## 2026-09-27 — ticks no longer overlap

### Fixed

- [#35](https://github.com/seregatipich/squad-admin-panel/issues/35) (finding 999):
  the tick ran on a bare `setInterval`, so a slow pass — a scheduled restart
  waits on `containerStop` for up to two minutes before `last_executed_at` is
  written — overlapped the next one, which read the task as still due and
  restarted the server again (and likewise duplicated rotation/seed layer
  commands). `src/tick-loop.ts` now schedules each tick with `setTimeout`
  only after the previous one settles; `SCHEDULER_INTERVAL_MS` is the pause
  between ticks. Regression test: `test/tick-loop.test.ts`.

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
