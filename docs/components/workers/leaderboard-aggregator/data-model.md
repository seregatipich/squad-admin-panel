# worker-leaderboard-aggregator - Data model

## Tables written

| Table | Operation | Notes |
|---|---|---|
| `player_stat_periods` | upsert and delete per period | Identity is the constraint `player_stat_periods_identity` on `(player_id, server_id, period_type, period_start)` with `NULLS NOT DISTINCT`. `server_id = NULL` is the per-player rollup row across servers. |
| `player_bonus_accruals` | `DELETE` everything, then `INSERT ... SELECT` | One row per player with `accrued_30d` and `computed_at`; both statements run in one transaction. |

## `player_stat_periods` recompute

For each period the worker runs one transaction (`recomputeLeaderboardPeriod`):

- Presence columns come from `player_daily_presence`, summed per player and server over the period's day range: `online_seconds`, `boost_seconds` and `seed_seconds` (stored as `seeding_seconds`).
- Combat columns come from `match_players` joined to `matches`, grouped per player and server and filtered by `matches.started_at` inside the period's UTC window: `matches_played` (distinct matches), `kills`, `deaths`, `teamkills`, `revives`.
- `kd_ratio` is `kills` when `deaths = 0`, else `kills / deaths`.
- `bonus_points` is `round((k_online * online_seconds + k_boost * boost_seconds + k_seed * seed_seconds) / 3600)` using `economy_settings` (`k_online`, `k_boost`, `k_seed`; defaults 1, 2, 3 when the row is missing). It mirrors the ledger units; it is not read from `bonus_transactions`.
- Per-server rows plus one rollup row with `server_id = NULL` are written. Rows whose values are unchanged are not rewritten (`ON CONFLICT ... DO UPDATE ... WHERE ... IS DISTINCT FROM`). Rows of that period that no longer appear in the computed set are deleted.
- `alltime` has no day filter, so it covers all presence and all matches.

## Periods recomputed per tick

`periodsToRecompute(now)` returns, de-duplicated by `period_type:period_start`:

| `period_type` | `period_start` |
|---|---|
| `day` | today (UTC) and yesterday |
| `week` | the week containing today and the week containing the day seven days ago |
| `month` | the current month and the previous calendar month |
| `alltime` | `1970-01-01` |

That is seven descriptors, plus one `season` period when a season is active. `alltime` is dropped from a tick when it was rebuilt less than one hour ago in the same process; the first tick after a start always includes it. Week starts follow `periodStartFor` (ISO week start).

## Season period

`loadActiveSeasonTarget` selects the single row of `seasons` with `status = 'active' AND finalized = false` (at most one row can be `active`, enforced by the `seasons_one_active` index). The period is `period_type = 'season'`, `period_start` is the UTC day of `starts_at`, and the explicit range is `[starts_at day, day of (ends_at - 1 ms)]`, both inclusive. A closed or finalized season is never returned, so its rows stop changing. A season's range cannot be derived from `period_start`, which is why it is passed explicitly.

## `player_bonus_accruals` recompute

`accrued_30d` is the sum of `bonus_transactions.amount` for types `earn_online`, `earn_boost` and `earn_seed` with `created_at` in `[now - 30 days, now]`, grouped by player. `adjust` and spend rows are not counted. Players with no accrual in the window have no row.

## Tables read

`player_daily_presence`, `match_players`, `matches`, `economy_settings`, `seasons`, `bonus_transactions`.

## Redis

- Writes `worker:heartbeat:leaderboard-aggregator` (TTL 30 s).
- Deletes `leaderboard:*` keys with `UNLINK` after each tick whose period recompute succeeded.
- Appends to `diag:queue`.

## Backfill

`backfillMonths(sql, months)` recomputes the `month` period for each of the last `months` calendar months, counting back from the current UTC month (the current month is the first). It writes only `player_stat_periods`.
