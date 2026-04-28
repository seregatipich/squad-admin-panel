# worker-event-partition — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-event-partition test
```

## Test files

All tests live under `apps/workers/event-partition/test/`.

### `partition.test.ts`

Unit tests for partition name computation.

| Test | What it verifies |
|---|---|
| Generates correct partition name for a given year/month | Zero-padded `events_YYYY_MM` format |
| Computes next month partition rolling over December → January | Year boundary handled correctly |
| Computes next month for a regular month | April → May |
| Current and next partition names are distinct | No off-by-one error |

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

The partition DDL logic is a placeholder. Phase 1 tests should cover:

- `CREATE TABLE IF NOT EXISTS` is idempotent when run on an existing partition.
- The correct partition name is computed for end-of-month boundary dates (e.g., 31 January → February partition name).
- On the 25th, the month-after-next partition is pre-created.
- Partitions older than 12 months are detached, not dropped.
- Graceful recovery when Postgres is temporarily unavailable (error logged, retry on next tick).
