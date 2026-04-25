# worker-event-partition — Testing

## Running tests

```bash
pnpm --filter @squad/worker-event-partition test
```

Runs with `--passWithNoTests`. There are no test files in the current implementation.

## Coverage gaps

The partition DDL logic is a placeholder. Phase 1 tests should cover:

- `CREATE TABLE IF NOT EXISTS` is idempotent when run on an existing partition.
- The correct partition name is computed for end-of-month boundary dates (e.g., 31 January → February partition name).
- On the 25th, the month-after-next partition is pre-created.
- Partitions older than 12 months are detached, not dropped.
- Graceful recovery when Postgres is temporarily unavailable (error logged, retry on next tick).
