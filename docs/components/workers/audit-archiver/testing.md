# worker-audit-archiver — Testing

## Running tests

```bash
pnpm --filter @squad/worker-audit-archiver test
```

The test suite runs with `--passWithNoTests` — there are no test files in the P0 stub.

## Coverage gaps

The entire archival logic is deferred to Phase 1. When Phase 1 ships, the following must be tested:

- Hash-chain verification on a sample `audit_log` slice.
- JSONL serialisation round-trip.
- Deletion via `audit_log_archive_view` succeeds and removes the correct rows.
- Rows that fail hash verification are not deleted (integrity protection).
- Worker recovers from a failed archive run and retries on the next cron tick.

Use `pnpm verify:audit-chain` (in `scripts/verify-audit-chain.ts`) as the integration baseline for the hash-chain logic.
