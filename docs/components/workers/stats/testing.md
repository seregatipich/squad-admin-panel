# worker-stats — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-stats test
```

The `contract.test.ts` subprocess tests spawn `dist/index.js`, so build first
(`pnpm --filter @squad/worker-stats build`).

## Test files

All tests live under `apps/workers/stats/test/`.

### `reconcile-tick.test.ts`

Unit tests for `runStatsReconcileTick` with `reconcileDossierAggregates` mocked.

| Test | What it verifies |
|---|---|
| emits `run_ok` when consistent | no-drift result → `dossier_reconcile.run_ok` (info) |
| emits `drift_detected` with counts | non-zero drift → `dossier_reconcile.drift_detected` (warn) carrying per-table counts |
| reconciles the last 48h, report-only | called as `reconcileDossierAggregates(sql, { windowHours: 48 })`, never `{ repair: true }` |
| emits `run_failed` on throw | reconcile rejects → `dossier_reconcile.run_failed` (error) |

The windowed-reconcile behaviour itself (drift detection, `repair`, aged-partition
tolerance) is covered by the DB-backed `packages/db/test/dossier-aggregate.test.ts`.

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:stats` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |
