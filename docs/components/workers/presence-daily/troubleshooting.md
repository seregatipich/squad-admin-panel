# worker-presence-daily - Troubleshooting

## Daily presence, statistics or co-play look stale

**Diagnostic:**

```bash
redis-cli TTL worker:heartbeat:presence-daily
docker compose logs worker-presence-daily --since 2h | grep -E 'recompute|rollup|accrual|failed'
redis-cli XREVRANGE diag:queue + - COUNT 50
```

Look for `presence_daily.run_ok`, `server_daily_stats.run_ok`, `coplay.run_ok` and `economy_accrual.run_ok` among the recent `diag:queue` entries (component `worker-presence-daily`). The tick is hourly, so data can lag by up to an hour.

**Possible causes:**

1. The heartbeat key is absent: the worker is not running. Check that the service started and that `DATABASE_URL` is set.
2. One step reports `*.run_failed`: read the event `message` or the matching log line. The other steps keep running, so one table can be stale while the rest are fresh.
3. `player_sessions` itself is empty or stale: this worker only aggregates sessions written by `worker-rcon`.
4. Activity older than yesterday is missing: the tick only rewrites yesterday and today. Older days are never rebuilt by this worker.

## `economy_accrual.run_failed` for one day

Each failed day is reported with its `day`. The other days in the window still accrue, and `economy_accrual.run_ok` is withheld until a tick where every day succeeds. The next hourly tick retries the same days. A persistent failure on a single day points at that day's data; read the `message`.

## Bonuses are not accruing

`economy_accrual.run_ok` with `economyEnabled: false` means `economy_settings.economy_enabled` is off: seed seconds are still attributed, but no `bonus_transactions` or balances change. If it is enabled and the counts are 0, check that `player_daily_presence` has rows for the day (step 1 must succeed first).

## Seed seconds changed for an old day

Accrual rewrites `seed_seconds` for yesterday and today on every tick. If a server emits its first `server.seeding_started` or `server.seeding_ended` event, its attribution switches from the `seed_threshold` concurrency sweep to seeding windows, and both days change retroactively. This is expected.

## Running the co-play full rebuild

Set `COPLAY_FULL_REBUILD=1` on a one-shot container, not on the service:

```bash
docker compose run --rm -e COPLAY_FULL_REBUILD=1 worker-presence-daily
```

Success is `coplay.full_rebuild_ok` with the row count; failure is `coplay.full_rebuild_failed`. The rebuild deletes and rewrites every co-play bucket in one transaction, so it can take long on a large `player_sessions` table. Stop the one-shot container afterwards: it continues into the hourly loop.

## Tick takes longer than an hour

The tick policy is `overlap: 'allow'`, so a second tick starts concurrently. The pool has a single connection, so the queries serialise, and accrual's per-day advisory lock prevents double accrual. If this repeats, look for slow steps in the logs and check the size of `player_sessions`.

## Useful commands

```bash
redis-cli GET worker:heartbeat:presence-daily
docker compose logs worker-presence-daily -f --since 2m
```
