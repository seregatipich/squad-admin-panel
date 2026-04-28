# worker-diag-flush

## Purpose

Drains the `diag:queue` Redis Stream into the partitioned Postgres table `diagnostic_events` in batches. It is the durable consumer half of [`@squad/diag`](../../diag/README.md): producers (`api`, workers, the bridge journald exporter once landed) `XADD` events, this worker reads them with `XREADGROUP` and inserts them so the diagnostic-bundle endpoint can serve historical queries.

## Responsibilities

- Create / re-attach to the consumer group `diag-flush` on `diag:queue` (with `MKSTREAM` so the stream exists if no producer has written yet).
- `XREADGROUP` blocking reads up to `DIAG_FLUSH_BATCH_SIZE` entries (default 100) at a time with a 1 s `BLOCK` timeout.
- Parse each entry's flat `[key, value, key, value, ...]` field list back into a `DiagEvent`-shaped row.
- Build a single multi-row `INSERT INTO diagnostic_events ... ON CONFLICT (id, ts) DO NOTHING` per batch.
- `XACK` every entry id (valid AND malformed) after the insert, so a poison row never blocks the pipeline.
- Publish `worker:heartbeat:diag-flush` every 5 s with TTL 30 s.
- Drain on `SIGTERM`: stop the loop, end the pg pool, quit Redis, exit 0.

## What it does not do

- Does not produce diagnostic events — `@squad/diag.emit` is the producer side.
- Does not decode payloads, derive metrics, or trigger alerts — that is the diagnostic-bundle endpoint's job.
- Does not rotate Postgres partitions — `worker-event-partition` (and pg_partman in P1) owns that.
- Does not back-pressure producers. The Redis Stream `diag:queue` has `MAXLEN ~ 100000` set by the producer, so a stalled consumer trims oldest entries instead of stopping writes.
- Does not retry per-entry parse failures. A malformed row is logged at `warn` and `XACK`ed once; it is not re-delivered.

## Code location

```
apps/workers/diag-flush/
  src/
    index.ts          — entry point + flushBatch() exported for unit tests
  test/
    contract.test.ts  — flushBatch() unit tests (parse, INSERT shape, XACK behaviour)
  package.json
  tsconfig.json
  vitest.config.ts
```

## Dependencies

- [`@squad/shared-config`](../../shared-config/README.md) — `DIAG_STREAM_KEY`, `startHeartbeat`.
- [`@squad/diag`](../../diag/README.md) — wire-format contract only (NOT a package dependency). The worker re-derives the row shape from the flat XREAD field list and never imports `@squad/diag`. Producers must use `@squad/diag.emit` so the entries match what `parseEntry` accepts.
- `ioredis` — Redis client (`xreadgroup`, `xack`, `xgroup`).
- `postgres` — driver. The worker uses `sql.unsafe(text, args)` for batched INSERTs because Drizzle's tagged-template helpers do not compose well over a variable row count.
- `pino` — structured logging.

## Components that depend on it

- [`diagnostic-bundle`](../../diagnostic-bundle/README.md) (Phase A2 onward) — selects from `diagnostic_events` via the API. If this worker is dead, the bundle endpoint reports degraded freshness.
- The API health surface — `/api/v1/health/workers` aggregates the heartbeat key `worker:heartbeat:diag-flush`.

## Components it depends on

- Redis (`diag:queue` Redis Stream — created on startup with `MKSTREAM`).
- Postgres (`diagnostic_events` partitioned table; migration `0017_diagnostic_events.sql`, schema `packages/db/src/schema/diagnostic-events.ts`).

## Basic usage

```sh
docker compose up -d worker-diag-flush
docker compose logs worker-diag-flush --since 2m
```

Verify it is alive:

```sh
redis-cli ttl worker:heartbeat:diag-flush   # 0 < ttl <= 30
```

Verify the consumer group is wired up:

```sh
redis-cli xinfo groups diag:queue
# expect: name=diag-flush  consumers=1  pending=0  last-delivered-id=...
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
