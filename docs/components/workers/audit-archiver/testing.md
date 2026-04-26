# worker-audit-archiver — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-audit-archiver test
```

## Test files

All tests live under `apps/workers/audit-archiver/test/`.

### `archive.test.ts`

Unit tests for stub behavior.

| Test | What it verifies |
|---|---|
| `startHeartbeat` publishes key with EX TTL | Heartbeat writes `worker:heartbeat:audit-archiver` with TTL ≤ 30s |
| Does not throw when redis is null | Graceful no-op when `REDIS_URL` is not configured |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:audit-archiver` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

The entire archival logic is deferred to Phase 1. When Phase 1 ships, the following must be tested:

- Hash-chain verification on a sample `audit_log` slice.
- JSONL serialisation round-trip.
- Deletion via `audit_log_archive_view` succeeds and removes the correct rows.
- Rows that fail hash verification are not deleted (integrity protection).
- Worker recovers from a failed archive run and retries on the next cron tick.

Use `pnpm verify:audit-chain` (in `scripts/verify-audit-chain.ts`) as the integration baseline for the hash-chain logic.
