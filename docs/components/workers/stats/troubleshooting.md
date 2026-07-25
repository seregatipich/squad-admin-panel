# worker-stats — Troubleshooting

**Container restarting:** `docker compose logs worker-stats --since 5m`.

**Heartbeat absent:** the worker publishes `worker:heartbeat:stats` whenever
`REDIS_URL` is set. If it is missing, check `REDIS_URL` and Redis connectivity.

**`dossier_reconcile.drift_detected` warning:** the reconcile guard found aggregates
that do not reflect recent `combat_events`. The payload carries per-table counts
(`weaponStats`, `vehicleStats`, `vehicleKills`, `total`). Common causes: a bug or
manual DB change, or `combat_events` written without the aggregate fold (e.g. a
backfill). Investigate first; the tick never repairs on its own.

**Repairing drift (operator-only):** rebuild the aggregates from all retained
`combat_events`:

```ts
import { reconcileDossierAggregates } from '@squad/db';
await reconcileDossierAggregates(sql, { repair: true });
```

This is **destructive** — it `DELETE`s and rebuilds the three aggregate tables from
whatever `combat_events` partitions still exist, so run it only while the
contributing partitions are still retained. It is never invoked by the scheduled
tick.

**`dossier_reconcile.run_failed` error:** the reconcile query threw (usually a DB
connectivity issue). The worker keeps ticking; check `DATABASE_URL` and Postgres.
