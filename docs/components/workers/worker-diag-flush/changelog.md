# Changelog

## 2026-04-28

### Added

- Initial implementation of `worker-diag-flush` (Phase A1, Task 4 of the diagnostic-bundle plan).
- `flushBatch({ sql, redis, group, stream, entries })` — exported pure function that parses a Redis Stream batch, issues one multi-row `INSERT INTO diagnostic_events ... ON CONFLICT (id, ts) DO NOTHING`, then `XACK`s every entry id (including malformed ones).
- `parseEntry(fields)` — exported helper that converts the flat XREAD field list into a typed row, returning `null` if any required field (`id`, `ts`, `component`, `severity`, `kind`, `message`) is missing.
- Main loop: `XREADGROUP GROUP diag-flush diag-flush-${pid} COUNT $DIAG_FLUSH_BATCH_SIZE BLOCK 1000 STREAMS diag:queue >`.
- Consumer group `diag-flush` created idempotently with `XGROUP CREATE diag:queue diag-flush $ MKSTREAM`; `BUSYGROUP` errors are swallowed.
- Heartbeat publisher writing `worker:heartbeat:diag-flush` (TTL 30 s) via `startHeartbeat`.
- Graceful shutdown on `SIGINT`/`SIGTERM`: stop loop, end pg pool with 5 s timeout, quit Redis, exit 0.
- Vitest unit suite (`test/contract.test.ts`, 4 cases) covering: well-formed batch INSERT shape + XACK, malformed-only batch (XACK without INSERT), mixed batch (INSERT for valid + XACK both), empty-input short-circuit.
- Compose service `worker-diag-flush` wired up in `docker-compose.yml`, depends on postgres + redis + migrator.

### Changed

- _None._

### Fixed

- _None._

### Removed

- _None._

### Migration notes

- No DB migration in this change. The `diagnostic_events` partitioned table was added in migration `0017_diagnostic_events.sql` (commit `d68fb21`).
- The `@squad/diag` producer (commit `b022a9b` for the package fixup) was the prerequisite. Producers must use `createDiag().emit()` from `@squad/diag` so the entry shape matches what `parseEntry` expects.
- New env var `DIAG_FLUSH_BATCH_SIZE` (default `100`) — documented in [configuration.md](./configuration.md). Operators may tune up for higher throughput.

### References

- Spec: [`docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`](../../../superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) §3.2
- Plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 4
