# Changelog — worker-log-ingest

## 2026-09-09

### Fixed

- `handleMatchClose` now applies `filterRosterByPlaySeconds` — the join-grace floor (`DEFAULT_JOIN_GRACE_SECONDS`, 60 s) that had been defined since MATCH-2 but never called. Production opens **two** `matches` rows per round ([#330](https://github.com/breaking-squad/squad-admin-panel/issues/330)): a ~3 ms "ghost" carrying the layer, and the real round with `layer = NULL`. The ghost's window overlaps every open session, so once the RCON presence projection ([#320](https://github.com/breaking-squad/squad-admin-panel/issues/320)) started filling `player_sessions`, the ghost collected a full roster of `play_seconds = 0` rows — doubling `COUNT(DISTINCT matches.id)` in the dossier's «Скилл» tab and polluting every match list. While `player_sessions` was empty this was invisible, because every roster came back empty.
- The floor also drops genuine connect-and-leaves (a player present for under a minute is no longer counted as having played the round), which is what the constant was defined for.
- `test/ghost-match-roster.regression.test.ts` pins all three cases: a millisecond ghost writes nothing, the real round still writes its full roster, and a sub-grace player is dropped while the rest are kept.

## 2026-07-29

### Fixed

- #228: `test/vote-store.test.ts` / `test/match-roster-store.test.ts` moved their
  hardcoded `players.eos_id`/`players.steam_id64` fixture literals to disjoint
  per-file ranges — they previously shared `0002aaaa…`/`0002bbbb…`/`0002cccc…`
  eos_ids and `76561198000000001`/`…004` steam_id64s with `test/combat-store.test.ts`,
  so a persistent (non-recreated) database that still held one file's rows made
  the next file's `beforeAll` insert fail on `players_eos_id_unique_idx` /
  `players_steam_id64_unique_idx`. Invisible in CI, which provisions a fresh
  database per run.
- `test/fixture-isolation.regression.test.ts`: new static guard (mirrors
  `apps/api/test/test-isolation.regression.test.ts`) asserting `combat-store`,
  `vote-store` and `match-roster-store` never declare the same eos_id/steam_id64
  fixture literal.

## 2026-07-25

### Added

- DOSSIER-2 (#189): `src/combat/store.ts` now writes the typed `combat_events` row
  and folds the per-weapon/per-vehicle dossier aggregates
  (`player_weapon_stats`, `player_vehicle_stats`, `player_vehicle_kills`) via
  `applyCombatEventToDossier`, in the **same transaction** as the `events` envelope
  insert. The `combat_events` insert and the aggregate fold run only when the
  envelope actually inserted, so offset replay never double-counts. The `live-bus`
  publish stays outside the transaction.
- `test/combat-store.test.ts` / `test/vehicle-store.test.ts`: DB-backed coverage of
  the atomic `combat_events` + aggregate writes, teamkill vs kill, damage/shots
  accumulation, attacker-vehicle stats, EOS-only aggregation by uuid, wound recorded
  without aggregate movement, and replay idempotency.

### Notes

- `combat_events.match_id` is written `NULL`: the column is `bigint` while log-ingest
  resolves a `uuid` match id (a COMBAT-2/DOSSIER-1 schema gap, out of scope). The
  aggregates and the reconcile guard do not use it.

## 2026-07-09

### Added

- `PLAYER_REMOTE_ADDR` pattern (`src/parser/patterns.ts`): matches `LogNet: AddClientConnection … RemoteAddr: <ip>:<port> … EOSNetDriver …`, the client IP captured at connection setup.
- `LogIngestor` now correlates the `AddClientConnection` line with the following `Join succeeded` line (within the existing join correlation window) and carries the resolved IP through to the `player.connected` event's `ip` field, replacing the previous hardcoded `null`.

## 2026-07-07

### Added

- `src/retention.ts`: bridge-backed raw Squad log retention sweep. Runs once on startup and then hourly.
- `log.retention.sweep` diagnostic event with `deleted_count`, `deleted_bytes`, `error_count`, scan counters, retention days, cutoff, and bounded error summaries.
- `log.retention.sweep_failed` diagnostic event for bridge-level failures. The worker logs the failure and retries on the next hourly tick instead of exiting.
- `test/retention.test.ts`: covers successful counter logging/diag emit, bridge failure handling, and scheduler stop behaviour.

### Changed

- `index.ts` starts and stops the retention scheduler alongside heartbeat, reconcile, and active log tails.

## 2026-04-28

### Fixed

- `docker-compose.yml`: replaced `group_add: [${PANEL_GID:-987}]` with `user: "0:${PANEL_GID:-987}"`. The previous form left the container running with `gid=0(root)` as primary GID; the bridge's SO_PEERCRED check inspects the primary GID and rejected every `containerLogsFollow` call with `rejected untrusted peer`. See [`docs/components/bridge/troubleshooting.md`](../../bridge/troubleshooting.md) and the matching [`config-sync` changelog entry](../config-sync/changelog.md#2026-04-28).
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
