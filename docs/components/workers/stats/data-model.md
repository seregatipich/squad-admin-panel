# worker-stats — Data model

The reconcile guard is **read-only** in report mode: it reads `combat_events` and
the three dossier aggregate tables and compares them; it writes nothing back.

## Reads

- `combat_events` — the raw kill/damage/vehicle feed, filtered to the last
  `RECONCILE_WINDOW_HOURS` (48 h) by `occurred_at`. Written by `worker-log-ingest`.
- `player_weapon_stats`, `player_vehicle_stats`, `player_vehicle_kills` — the
  incrementally-maintained dossier aggregates (see
  [db/data-model.md](../../db/data-model.md)).

## Drift detection

For each aggregate table the guard recomputes the expected contribution of the
windowed `combat_events` and flags a key when the stored aggregate is **missing or
below** that lower bound. Because the stored aggregates are cumulative (they outlive
the `combat_events` retention), the windowed recompute is always a lower bound —
this never false-positives on aged-out partitions or normal cumulative history. The
per-table drift counts are returned by `reconcileDossierAggregates()` in
`packages/db/src/dossier/aggregate.ts`.

## Writes

None in report mode. `reconcileDossierAggregates(sql, { repair: true })` rebuilds
the aggregates from all retained `combat_events`, but that is an **explicit,
operator-only** procedure — the scheduled tick never passes `repair`.
