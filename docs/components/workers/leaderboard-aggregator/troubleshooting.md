# worker-leaderboard-aggregator - Troubleshooting

## Leaderboards do not update

**Diagnostic:**

```bash
redis-cli TTL worker:heartbeat:leaderboard-aggregator
docker compose logs worker-leaderboard-aggregator --since 30m | grep -E 'leaderboard|failed|skipping'
redis-cli XREVRANGE diag:queue + - COUNT 50
```

Look for `leaderboard_aggregator.run_ok` and `leaderboard_aggregator.run_failed` among the recent `diag:queue` entries (component `worker-leaderboard-aggregator`).

**Possible causes:**

1. The heartbeat key is absent: the worker is not running. Check that the service started and that `DATABASE_URL` is set.
2. `run_failed` repeats: the period recompute throws; read the `message` in the event or the `leaderboard recompute failed` log line. While it fails, the accrual rebuild and cache invalidation are skipped too.
3. The interval is too long: an invalid `LEADERBOARD_AGGREGATOR_INTERVAL_MS` falls back to 900000 ms silently, and a very large value delays every tick.
4. Online, boost and seeding numbers are stale while combat numbers are fresh: those inputs come from `player_daily_presence`, which `worker-presence-daily` rebuilds hourly. Check that worker.

## Numbers are right in the database but the page shows old data

The API caches leaderboard responses under `leaderboard:*` for 60 s. The worker clears them after a successful recompute only when Redis is configured. If `run_ok` reports `invalidated: 0` repeatedly while cached keys exist, check that the worker's `REDIS_URL` points at the same Redis as the API.

## `previous leaderboard tick still running, skipping this interval`

A tick outlasted the interval. The worker has one pooled connection, so overlapping recomputes are skipped on purpose. The usual cause is a large `alltime` rebuild or a large `match_players` table. Raise `LEADERBOARD_AGGREGATOR_INTERVAL_MS` if it repeats on every interval.

## Bonus leaderboard (30 d) is empty or stale

`leaderboard_aggregator.bonus_accruals_failed` means the rebuild threw; the previous rows stay because the delete and insert run in one transaction. Without that event, an empty `player_bonus_accruals` means no `earn_online`, `earn_boost` or `earn_seed` rows in `bonus_transactions` within the last 30 days. Those ledger rows are written by `worker-presence-daily`.

## The current season shows no data

`leaderboard_aggregator.season_window_failed` means the season lookup threw. Otherwise confirm in `seasons` that the season has `status = 'active'` and `finalized = false`: closed and finalized seasons are deliberately skipped, and an `upcoming` season is not recomputed. The season window is `[starts_at day, day of ends_at - 1 ms]` in UTC.

## Historical combat data is missing

Set `LEADERBOARD_BACKFILL_MONTHS` to the number of months needed and restart the worker; look for `leaderboard_aggregator.backfill_ok`. Only `month` periods are backfilled. Reset the variable to 0 afterwards, otherwise every restart repeats the backfill.

## Useful commands

```bash
redis-cli GET worker:heartbeat:leaderboard-aggregator
docker compose logs worker-leaderboard-aggregator -f --since 2m
```
