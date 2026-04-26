# Changelog — worker-event-partition

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