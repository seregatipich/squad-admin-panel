# worker-diag-flush — Troubleshooting

## Heartbeat key missing or expired

**Symptom**: `GET /api/v1/health/workers` reports `diag-flush` as missing, or `redis-cli ttl worker:heartbeat:diag-flush` returns `-2`.

**Possible causes**:

1. The worker container is not running.
2. The worker crashed in a tight crash-loop and the heartbeat has not had 5 s to publish.
3. Redis is unreachable from the worker container.

**Diagnosis**:

```sh
docker compose ps worker-diag-flush
docker compose logs worker-diag-flush --since 5m
redis-cli get worker:heartbeat:diag-flush
redis-cli ttl worker:heartbeat:diag-flush
```

**Fix**:

- If the container is stopped: `docker compose up -d worker-diag-flush`.
- If the container is restarting: `docker compose logs worker-diag-flush --since 2m | tail -50` and read the fatal line. The most common is `DATABASE_URL is required` — verify `.env` is populated and re-create the container.

## Pending entries climb without bound

**Symptom**: `redis-cli xlen diag:queue` shows a number that only grows; `redis-cli xinfo groups diag:queue` shows `pending` thousands.

**Possible causes**:

1. Postgres is rejecting INSERTs (constraint violation, dead pool, partition missing).
2. The worker is dead and consumer entries are claimed by the old `diag-flush-${old_pid}` consumer.

**Diagnosis**:

```sh
redis-cli xinfo groups diag:queue
redis-cli xpending diag:queue diag-flush
docker compose logs worker-diag-flush --since 5m | grep -E "flush iteration failed|fatal"
psql -d admin -c "SELECT count(*) FROM diagnostic_events WHERE ts > now() - interval '5 minutes';"
```

**Fix — Postgres rejection path**:

- If logs show `severity` CHECK violation → producer is sending an unknown severity. Patch the producer; the batch will retry on next iteration once it stops poisoning.
- If logs show `relation "diagnostic_events" does not exist` → migrator did not run; `docker compose run --rm migrator` to rerun and recreate the container.

**Fix — dead-consumer path**:

- Restart the worker (`docker compose restart worker-diag-flush`).
- If pending stays high, manually reclaim with `XAUTOCLAIM` to the new consumer name:
  ```sh
  redis-cli xautoclaim diag:queue diag-flush diag-flush-${NEW_PID} 60000 0
  ```
  where `NEW_PID` is the pid of the new container's process (visible via `docker compose top worker-diag-flush`). 60000 ms is the min-idle threshold.

## Same row appears twice in Postgres

**Symptom**: `SELECT id, count(*) FROM diagnostic_events GROUP BY id HAVING count(*) > 1` returns rows.

**Cause**: Should be impossible. The composite PK `(id, ts)` plus `ON CONFLICT DO NOTHING` blocks duplicates by construction. If two rows share the same `id` but different `ts`, the producer is generating non-monotonic UUIDv7s — a producer bug.

**Diagnosis**:

```sh
psql -d admin -c "SELECT id, ts, component FROM diagnostic_events WHERE id = '<dup_id>' ORDER BY ts;"
```

**Fix**: Investigate the producer. UUIDv7 is supposed to be monotonic per process; the `uuid` package's `v7` does include a per-process counter. Two events with the same `id` from different processes is a collision (statistically impossible at typical event rates) — re-run with `LOG_LEVEL=debug` on the producer side to capture the offending caller stack.

## Worker logs `BUSYGROUP` on startup

**Symptom**: log line `Consumer Group name already exists`.

**Cause**: Expected on every start after the first. The code swallows `BUSYGROUP` explicitly. If you see it as an `error` log it means the catch missed it.

**Fix**: None required. If the message is at a level higher than `info`, file a bug — the catch in `main()` should have absorbed it.

## Worker logs `flush iteration failed` then recovers

**Symptom**: occasional `error`-level lines like `flush iteration failed: connect ECONNREFUSED ...` followed by normal operation.

**Cause**: Transient Postgres or Redis hiccup. The 1 s back-off + redelivery pattern handles this — no action needed.

**Fix**: If the error rate exceeds ~1/min, investigate the pg/redis logs. Sustained errors usually indicate a network partition between the compose network and the postgres/redis containers.

## INSERTs are slow, blocking the loop

**Symptom**: heartbeat key TTL drops below 20 s; `pg_stat_activity` shows long `INSERT INTO diagnostic_events`.

**Cause**: Index bloat, vacuum starvation, partition full, or `actor_steam_id64` contention.

**Diagnosis**:

```sh
psql -d admin -c "SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE relname = 'diagnostic_events';"
psql -d admin -c "SELECT * FROM pg_stat_activity WHERE query LIKE '%diagnostic_events%';"
```

**Fix**:

- Run `VACUUM ANALYZE diagnostic_events` if `last_autovacuum` is hours old.
- Lower `DIAG_FLUSH_BATCH_SIZE` to reduce per-statement work.
- Check the partition manager (`worker-event-partition`) is alive — without partition rotation the table grows unbounded.

## Useful one-liners

```sh
# how many entries waiting?
redis-cli xlen diag:queue

# consumer-group state
redis-cli xinfo groups diag:queue

# pending list (claimed but not yet ACKed)
redis-cli xpending diag:queue diag-flush 10

# tail of recent inserts
psql -d admin -c "SELECT ts, component, severity, kind, message FROM diagnostic_events ORDER BY ts DESC LIMIT 20;"

# worker state
docker compose ps worker-diag-flush
docker compose logs worker-diag-flush --since 2m
redis-cli get worker:heartbeat:diag-flush | jq
```

## Useful metrics (when the metrics-pack lands)

- `diag.flush.batch_size` — distribution of `entries.length` per loop. Spikes near `DIAG_FLUSH_BATCH_SIZE` mean the worker is saturated.
- `diag.flush.malformed` — counter of `parseEntry` returning `null`. Should be 0 in steady state.
- `diag.flush.pg_error` — counter of `flush iteration failed` logs. Sustained > 0 means Postgres trouble.
