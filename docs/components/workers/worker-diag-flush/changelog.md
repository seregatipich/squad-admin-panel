# Changelog

## 2026-04-29

### Fixed

- Post-merge fix: `JournaldForwarderHandle.drain()` awaits in-flight journald handlers + child exit before Redis teardown. Previously, the shutdown sequence sent SIGTERM to the `journalctl` child but did not await `handleJournaldLine` promises that had already been dispatched from buffered stdout chunks; those promises could call `redis.xadd(...)` after `redis.quit()` and emit "redis closed" warnings during teardown. The forwarder now tracks each in-flight handler in a `Set<Promise<void>>`, exposes a `drain()` method that waits for the child's `exit`/`close` event and `Promise.allSettled` over the in-flight set, and `main()` calls `await journald?.drain()` between `journald.stop()` and `sql.end(...)`. Two new test cases in [`test/journald.test.ts`](../../../../apps/workers/diag-flush/test/journald.test.ts) cover the drain behaviour with a fake child + a controllable slow `xadd`.

### Added

- New journald-bridge forwarder ([`apps/workers/diag-flush/src/journald-bridge.ts`](../../../../apps/workers/diag-flush/src/journald-bridge.ts), Task 17 — Phase A2 final task). The worker now spawns `journalctl -u panel-host-bridge -o json -f --since "30s ago"` as a child process at startup, parses each line, and `XADD`s entries that contain `DIAG_EVENT: "1"` into `diag:queue` so they merge with the rest of the diag stream consumed by the same worker. The Go bridge writes the marker lines via `handlers.DiagLog(...)`; see [`docs/components/bridge/api.md`](../../bridge/api.md#diagnostic-events-journald). This avoids giving the privileged daemon a Redis connection.
- Three new exports from `src/journald-bridge.ts`: `startJournaldForwarder({ redis, log, unitName?, since?, spawnFn? })`, `parseJournaldLine(line)`, `handleJournaldLine(line, opts)`.
- New env vars `DIAG_JOURNALD_FORWARD` (default `true`), `DIAG_JOURNALD_UNIT` (default `panel-host-bridge`), `DIAG_JOURNALD_SINCE` (default `30s ago`).
- New compose service mounts: `/var/log/journal:/var/log/journal:ro` and `/etc/machine-id:/etc/machine-id:ro` so `journalctl` can read the host journal from inside the container.
- `worker.Dockerfile` now installs the `systemd` package (which provides `journalctl`) when `WORKER=diag-flush`. Other worker images stay slim.
- New unit suite [`test/journald.test.ts`](../../../../apps/workers/diag-flush/test/journald.test.ts) — 8 cases on `parseJournaldLine` (happy path, blank, non-JSON, missing MESSAGE, plain log line, missing DIAG_EVENT, missing required field, default `ts`) and 3 cases on `handleJournaldLine` (XADD wire shape with `MAXLEN ~ 100_000`, skip non-diag lines, skip blank lines).
- New `uuid` runtime dependency on the diag-flush package (forwarder uses `v7 as uuidv7` to mint stream entry ids).
- Earlier on the same day: emits `diag_flush.started` / `diag_flush.stopped` (added pre-Task-17). Per-iteration `run_ok`/`run_failed` are intentionally NOT emitted — the consumer loop is continuous and would saturate the stream.
- `emitStarted` / `emitStopped` helpers exported from `src/index.ts` to keep the emits unit-testable.
- Re-added `@squad/diag` workspace dependency (it was removed in the 2026-04-28 changelog when the worker was a pure consumer; it now also produces lifecycle events).
- `test/diag-lifecycle.test.ts` covering both helpers.

### Changed

- `main()` shutdown handler now calls `journald?.stop()` before awaiting the in-flight batch and tearing down the SQL/Redis pools. The forwarder receives `SIGTERM` and exits cleanly.
- Replaced the `process.env.VITEST !== 'true'` guard around `main()` with the same `realpathSync` entrypoint check used by `worker-event-partition`. The previous guard prevented the spawned subprocess in the contract test from booting because `VITEST=true` leaks from the test runner into the spawn env.

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

- Removed unused `@squad/diag` workspace dependency from `apps/workers/diag-flush/package.json`. The worker consumes the Redis Stream produced by `@squad/diag` but never imports the package itself; only `@squad/shared-config` (`DIAG_STREAM_KEY`, `startHeartbeat`) plus `ioredis`/`pino`/`postgres` are referenced from `src/index.ts`. Refreshed `pnpm-lock.yaml` to drop the dangling workspace link.
- Graceful shutdown now awaits any in-flight `flushBatch` before tearing down the Postgres pool and closing Redis. The main loop assigns each iteration's batch work to an `inflight: Promise<void> | null`; `SIGINT`/`SIGTERM` flips `stopped`, awaits `inflight` (catching errors so teardown can proceed), then `sql.end({ timeout: 5 })` and `redis.quit()`. Prevents a SIGTERM-mid-batch from racing `XACK` against `redis.quit()` — re-delivery was harmless thanks to `ON CONFLICT (id, ts) DO NOTHING`, but the new ordering avoids the rerun on next startup.

### Fixed

- _None._

### Removed

- `@squad/diag` workspace dep from `apps/workers/diag-flush/package.json` (see Changed).

### Migration notes

- No DB migration in this change. The `diagnostic_events` partitioned table was added in migration `0017_diagnostic_events.sql` (commit `d68fb21`).
- The `@squad/diag` producer (commit `b022a9b` for the package fixup) was the prerequisite. Producers must use `createDiag().emit()` from `@squad/diag` so the entry shape matches what `parseEntry` expects.
- New env var `DIAG_FLUSH_BATCH_SIZE` (default `100`) — documented in [configuration.md](./configuration.md). Operators may tune up for higher throughput.

### References

- Spec: [`docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`](../../../superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) §3.2
- Plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 4
