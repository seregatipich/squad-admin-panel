# Changelog — worker-event-partition

## 2026-09-28

### Added

- Journal-table retention (issue #77): `pruneJournalTables(sql)` in `src/retention.ts`, run by every `runPartitionTick`, deletes delivered alerts after 90 days (any alert after 365), relayed `admins_cfg_sync_outbox` rows after 30 days, `scheduled_task_runs`, `chat_command_invocations` and `automation_runs` after 90 days, spent `media_upload_tokens` after 7 days, and clears `ban_appeals.submitter_ip` 30 days after the decision (90 days after submission at the latest). Rows still referenced by `expiry_notifications` or `media_files` are kept. Deletes run in batches of 5 000. `test/journal-retention.test.ts` covers every table and a backlog larger than one batch.

## 2026-09-27

### Fixed

- `chat_messages`, `bonus_transactions` and `combat_events` were never rotated (issue #6): their migrations created a fixed window of months and the pg_partman rotation their SQL files assumed was never installed. From 2026-11-01 every chat-log, bonus-ledger, manual-adjustment and VIP-grant insert on production would have failed with `no partition of relation … found for row`, and `combat_events` rows would have piled up in `combat_events_default`. New `ensureDefaultBackedMonthlyPartitions(sql, table)` over the exported `DEFAULT_BACKED_MONTHLY_TABLES`, wired into `runPartitionTick`, keeps the current + next month partitioned (UTC bounds), moving any rows the DEFAULT partition already holds for a new month into it before attaching. Nothing is dropped.
- Migration `0117_monthly_partition_defaults` gives `chat_messages` and `bonus_transactions` DEFAULT partitions and creates the current month and three months ahead for all three tables, so the outage is averted even before the worker's first tick.
- `test/default-backed-partition.test.ts`: real-database regression tests through `runPartitionTick`.

## 2026-09-09

### Added

- `ensurePlayerSessionPartitions(sql)`, wired into `runPartitionTick`: creates the current + next month `player_sessions_YYYY_MM` partitions (UTC bounds), mirroring `ensureMonthlyPartitions`. The PRES-1 migration created partitions only through a fixed calendar month; once worker-rcon began writing presence, an unrotated table would have started rejecting inserts with `no partition of relation "player_sessions" found` the first day past that window — taking match rosters and the whole dossier down with it. Nothing is ever dropped: sessions are lifetime playtime history and are not subject to the `events` retention window.

## 2026-07-09

### Added

- `ensureMonthlyPartitions(sql)` exported from `src/index.ts`: real hourly rotator for the `events` monthly partitions, replacing the `SELECT 1` stub. Mirrors `ensureDiagPartitions` exactly (no pg_partman): creates the current + next month `events_YYYY_MM` partitions (UTC month bounds) and drops any partition whose name sorts before `events_<YYYY_MM>` for `date_trunc('month', now()) - interval '24 months'` (24-month retention).
- `partition.test.ts` rewritten from asserting on a locally reimplemented partition-name helper to exercising the real `ensureMonthlyPartitions` against an isolated, migrated database: next-month creation (with `pg_get_expr` bound verification), current-month creation, dropping a pre-seeded >24-month-old partition, and keeping a pre-seeded within-retention partition.

## 2026-04-29

### Added

- Emits diagnostic events to `diag:queue` (`@squad/diag`):
  - `event_partition.started` (info) — right after `startHeartbeat` at startup.
  - `event_partition.run_ok` / `event_partition.run_failed` (info / error) — per hourly tick.
  - `event_partition.stopped` (info) — inside the SIGTERM/SIGINT handler before `process.exit`.
- New `runPartitionTick({ sql, diag })` exported from `src/index.ts` to keep the per-tick lifecycle emit logic unit-testable. The previous `tick()` helper has been folded into this exported version.
- `test/diag-lifecycle.test.ts` asserting both the `run_ok` and `run_failed` paths.
- Added `@squad/diag` workspace dependency.

## 2026-04-28

### Added

- `ensureDiagPartitions(sql)` exported from `src/index.ts`. Active hourly rotator for the `diagnostic_events` partitioned table introduced by migration `0017_diagnostic_events.sql`: keeps `[-1, 0, +1, +2]` days from today present (idempotent `CREATE TABLE IF NOT EXISTS`) and drops every child whose name sorts before yesterday (24h retention). Wired into the existing main loop so it runs alongside the events-table placeholder on each hourly tick.
- New `test/diag-partition.test.ts` with a stub `postgres-js`-shaped `sql`. Two cases: full create+drop sweep, and naming/range-format regex on every emitted `CREATE TABLE`.
- `isMainEntrypoint()` helper that compares `realpathSync(process.argv[1])` to `fileURLToPath(import.meta.url)`. Now gates the `main()` invocation so the file can be safely imported by unit tests without spawning a worker. Replaces the implicit "always run on import" pattern.

### Changed

- The hourly main loop now invokes a new `tick()` helper that runs `ensurePartitions()` and `ensureDiagPartitions(sql)` sequentially. Errors in either are caught and logged at `error` without killing the interval.

### Migration notes

- The bootstrap partitions for `diagnostic_events` come from migration `0017_diagnostic_events.sql` (yesterday + today + 23 future days). After this change they are kept current by the worker; you no longer need to run the migration to extend the buffer.

### Fixed (post-merge)

- Documented and enforced the UTC invariant for `diagnostic_events` partitions. Migration `0017_diagnostic_events.sql` used session-TZ-dependent `current_date` for its bootstrap loop, while `ensureDiagPartitions` derives partition names and bounds from `Date.toISOString()` (UTC). On a non-UTC Postgres deployment the worker's `CREATE TABLE IF NOT EXISTS` would silently skip a clashing-name bootstrap partition with mismatched bounds, producing "data lands outside any partition" failures. Added new migration `0018_diagnostic_events_utc_invariant.sql` (no-op `SELECT 1` plus comment) and a one-line invariant comment at the top of `ensureDiagPartitions`. Production Postgres MUST run with `TimeZone = 'UTC'`. Any non-UTC bootstrap partitions age out within 24h via the worker's drop-stale logic, after which the system converges.
- `tick()` now runs `ensurePartitions()` and `ensureDiagPartitions(sql)` via `Promise.allSettled` instead of sequential `await`. A transient pg failure in the events placeholder no longer starves diagnostic-events rotation; rejections are logged at `error` level individually.

## 2026-04-26

### Added

- Added `test/partition.test.ts`: partition name computation tests including year-boundary rollover.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- Initial stub: hourly interval, Postgres connection, heartbeat.
- `ensurePartitions()` placeholder (executes `SELECT 1`, no DDL yet).
- Graceful shutdown on SIGTERM/SIGINT.
- Initial partitions for the `events` table created by `0000_init.sql` (not by this worker).