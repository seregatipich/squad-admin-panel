# worker-stats — Flows

## Dossier reconcile tick

```
start
  ├─ DATABASE_URL unset → log "idle", keep heartbeat, wait for signal
  └─ DATABASE_URL set
       ├─ run one reconcile pass immediately
       └─ every 24 h (RECONCILE_INTERVAL_MS):
            reconcileDossierAggregates(sql, { windowHours: 48 })   # report-only
              ├─ total drift == 0 → emit dossier_reconcile.run_ok (info)
              ├─ total drift  > 0 → log warn + emit dossier_reconcile.drift_detected (warn)
              │                     with per-table counts { weaponStats, vehicleStats, vehicleKills, total }
              └─ throws          → emit dossier_reconcile.run_failed (error)
```

The tick is `runStatsReconcileTick({ sql, diag })` in `src/index.ts`. It always runs
in report mode (never `{ repair: true }`). Repairing drift is a deliberate operator
action — see [troubleshooting.md](./troubleshooting.md).

Shutdown: `SIGINT`/`SIGTERM` clear the interval, stop the heartbeat, close the SQL
pool and Redis, and exit 0.
