# worker-clan-priority-expirer - Troubleshooting

## An expired clan still has reserved slots in Admins.cfg

**Diagnostic:**

```bash
redis-cli GET worker:heartbeat:clan-priority-expirer
docker compose logs worker-clan-priority-expirer --since 10m | grep -E 'tick|failed'
```

```sql
SELECT id, name, priority_expires_at, priority_expiry_processed, deleted_at
FROM clans WHERE name = '<clan name>';
SELECT server_id, created_at, relayed_at, applied_at, last_error, reload_outcome
FROM admins_cfg_sync_outbox
WHERE payload->>'reason' = 'clan.priority.expire'
ORDER BY created_at DESC LIMIT 20;
```

**Possible causes:**

1. The worker is not running (heartbeat key absent), or every tick fails: look for `clan-priority-expirer tick failed` in the logs and `clan_priority_expirer.run_failed` in diagnostics.
2. `priority_expiry_processed` is already `true` but the sync never reached the server: the worker's job is done; check `worker-config-sync` and the `relayed_at` / `applied_at` / `last_error` columns above. See [config-sync troubleshooting](../config-sync/troubleshooting.md).
3. The clan is soft-deleted (`deleted_at` set): the worker skips it.
4. The server is `runtime = 'external'` or soft-deleted: no outbox row is created for it, and its Admins.cfg is not managed by the panel.

## A clan expired but there is no audit row or outbox row

The clan had no member with `has_priority = true` when the deadline passed. The worker marks such clans processed without an audit row or sync (nothing to remove from Admins.cfg). Check with:

```sql
SELECT count(*) FROM clan_members WHERE clan_id = '<clan id>' AND has_priority;
```

## Priorities did not come back after extending the deadline

Extending through `PATCH /api/v1/clans/:id/expire` resets `priority_expiry_processed` and enqueues a sync. If the deadline was changed directly in the database, `priority_expiry_processed` stays `true` and the clan will not be expired again when the new deadline passes; reset it manually. The per-member `has_priority` flags are never cleared by the worker, so no re-toggling is needed.

## Worker restarts in a loop

`DATABASE_URL is required` or `REDIS_URL is required` in the logs means the variable is missing (exit code 1). A failure of the very first tick (for example Postgres unreachable or a migration missing) is also fatal and exits with code 1; `restart: unless-stopped` then retries. After the first tick, failures are only logged. An invalid `CLAN_PRIORITY_EXPIRER_INTERVAL_MS` (zero, negative, non-numeric, fractional) throws `CLAN_PRIORITY_EXPIRER_INTERVAL_MS must be a positive integer, got "<value>"` at startup.

## `previous clan-priority-expirer tick still running; skipping`

A tick took longer than the interval. The skipped call is dropped, not queued. Check Postgres latency; the tick is a handful of statements and the transaction only runs when clans expired.

## Useful commands

```bash
docker compose logs worker-clan-priority-expirer -f --since 2m
redis-cli GET worker:heartbeat:clan-priority-expirer
```
