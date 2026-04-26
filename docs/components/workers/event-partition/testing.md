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
