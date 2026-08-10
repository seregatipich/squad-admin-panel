# worker-stats

## Purpose

Runs the **dossier-aggregate reconcile guard** (DOSSIER-2): a scheduled integrity
check that recomputes the per-weapon / per-vehicle dossier aggregates
(`player_weapon_stats`, `player_vehicle_stats`, `player_vehicle_kills`) from the
recent `combat_events` and alerts on any drift. The aggregates themselves are kept
current incrementally by `worker-log-ingest` (in the same transaction as each
`combat_events` insert); this worker is the safety net that catches events an
aggregate might have missed.

## Behaviour

On startup (when `DATABASE_URL` is set) the worker runs one reconcile pass, then
repeats it on a **nightly** interval (`RECONCILE_INTERVAL_MS`, 24 h). Each pass is
**windowed to the last 48 h** (`RECONCILE_WINDOW_HOURS`) of `combat_events` and is
**report-only** — it never rewrites the aggregates (a rebuild would erase the
multi-year history the aggregates keep after `combat_events` partitions age out).
It publishes a `worker:heartbeat:stats` Redis heartbeat and emits `dossier_reconcile.*`
diagnostics.

When `DATABASE_URL` is unset the worker idles (reconcile disabled) but still keeps
its heartbeat and graceful shutdown.

## Code location

```
apps/workers/stats/
  src/
    index.ts    — reconcile guard: nightly tick, 48 h window, report-only
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
