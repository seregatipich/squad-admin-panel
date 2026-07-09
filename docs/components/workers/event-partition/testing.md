# worker-event-partition — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-event-partition test
```

`test/partition.test.ts` additionally needs `DATABASE_URL` pointed at an isolated, migrated database (it is skipped otherwise):

```bash
eval "$(bash scripts/new-test-db.sh <slug>)"
pnpm --filter @squad/worker-event-partition exec vitest run test/partition.test.ts
```

## Test files

All tests live under `apps/workers/event-partition/test/`.

### `partition.test.ts`

Integration tests for `ensureMonthlyPartitions(sql)` against a real, migrated database (`DATABASE_URL` gated via `describe.skip` when unset — see `scripts/new-test-db.sh`).

| Test | What it verifies |
|---|---|
| Creates the next-month events partition with correct UTC month bounds | Drops the next-month partition first, runs `ensureMonthlyPartitions`, asserts it exists again in `pg_inherits` with the correct `FOR VALUES FROM/TO` bounds (via `pg_get_expr`) |
| Creates the current-month events partition if missing | Same, for the current month |
| Drops a pre-seeded partition older than the 24-month retention window | Seeds a ~40-month-old partition, runs the function, asserts it is gone |
| Keeps a pre-seeded partition that is within the 24-month retention window | Seeds a ~12-month-old partition, runs the function, asserts it survives |

### `diag-partition.test.ts`

Unit tests for `ensureDiagPartitions(sql)` — covers the `diagnostic_events` rotator.

| Test | What it verifies |
|---|---|
| Creates -1..+2 day partitions and drops partitions older than 24h | Mocked `sql` records 4 `CREATE TABLE IF NOT EXISTS` and 2 `DROP TABLE IF EXISTS` calls (driven by a stub `pg_inherits` result with two stale partitions) |
| `CREATE TABLE` statements use `diagnostic_events_<YYYYMMDD>` partition naming | Each emitted statement matches `/CREATE TABLE IF NOT EXISTS diagnostic_events_\d{8} PARTITION OF diagnostic_events FOR VALUES FROM \('\d{4}-\d{2}-\d{2}'\) TO \('\d{4}-\d{2}-\d{2}'\);/` |

Imports `ensureDiagPartitions` directly from `../src/index.js` and uses an inline `Object.assign(taggedTemplateFn, { unsafe: vi.fn() })` shape that mirrors what `postgres-js` exposes. Module-level `main()` is gated by an `isMainEntrypoint()` check (compares `realpathSync(process.argv[1])` to the resolved `import.meta.url`) so importing the file in a unit test does not start the worker.

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:event-partition` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

- `CREATE TABLE IF NOT EXISTS` idempotency when the partition already exists is exercised implicitly (every test run hits an existing current-month partition from the bootstrap migration) but has no dedicated assertion.
- End-of-month/year boundary partition naming (e.g. December → January rollover) is covered by construction (`Date.UTC` handles it) but not by a dedicated boundary test.
- Graceful recovery when Postgres is temporarily unavailable is covered at the `runPartitionTick` level (`diag-lifecycle.test.ts`, mocked `sql`) but not against a real dropped connection.
