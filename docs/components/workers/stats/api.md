# worker-stats — API surface

No HTTP surface. The worker publishes a heartbeat key and emits diagnostic events to the shared `diag:queue` Redis Stream.

## Heartbeat key: `worker:heartbeat:stats`

Published every 5 s (default interval), TTL 30 s — whenever `REDIS_URL` is set.

`status` field: `"idle"` (constant — the reconcile guard does not vary its heartbeat status by tick outcome; see [flows.md](./flows.md) for the reconcile tick itself).

## Diagnostic events (`diag:queue` Redis Stream)

The worker emits structured `DiagEvent`s via `@squad/diag` (`createDiag({ redis, log })`, constructed once at startup when `REDIS_URL` is set; a no-op `Diag` is used otherwise). All kinds carry `component: 'worker-stats'`. Each emit is `await`ed but never thrown. Emitted from `runStatsReconcileTick()` in `apps/workers/stats/src/index.ts`.

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `dossier_reconcile.run_ok` | `info` | The nightly reconcile pass found no drift. | `{ weaponStats: 0, vehicleStats: 0, vehicleKills: 0, total: 0 }` |
| `dossier_reconcile.drift_detected` | `warn` | The reconcile pass found the stored dossier aggregates below the recomputed lower bound for at least one key. | `{ weaponStats: number, vehicleStats: number, vehicleKills: number, total: number }` — per-table drift counts from `reconcileDossierAggregates()` |
| `dossier_reconcile.run_failed` | `error` | The reconcile pass threw (e.g. a Postgres error). | `{}` (the error message is logged via pino, not carried in the diag payload) |

## Retired: planned Redis Streams consumer group

`CONSUMER_GROUP.stats` in `packages/shared-types/src/events.ts` once named a planned consumer-group identifier for this worker to consume `events:server:{id}` streams. It is **not** used by `apps/workers/stats/src/index.ts` — the current worker reads Postgres directly via `reconcileDossierAggregates` instead. The constant is exercised only by `packages/shared-types/test/index.test.ts` and is otherwise dead in this worker.
