# worker-clan-priority-expirer - Flows

## Startup

`runWorker` (from `@squad/worker-kit`) performs:

1. Read `DATABASE_URL` and `REDIS_URL`; a missing one is fatal (exit 1). Open the Postgres pool and a Drizzle client, and connect Redis.
2. Start the heartbeat (`worker:heartbeat:clan-priority-expirer`, every 5 s) and create the diag emitter.
3. Build the tick from `setup()` and install the SIGINT/SIGTERM handlers.
4. Emit `clan_priority_expirer.started` with `{ pid }`.
5. Run one tick immediately. A failure of this first tick is fatal: the process logs `fatal` and exits with code 1 (the kit's default `firstRunFailure`), and `restart: unless-stopped` restarts it.
6. Mark the worker ready and arm a `setInterval` of `CLAN_PRIORITY_EXPIRER_INTERVAL_MS`.

A SIGTERM received before step 6 completes is remembered; shutdown runs once the first tick has finished and the interval is never armed.

## Expiry tick

Each tick logs `clan-priority-expirer tick` at `info` with `{ expiredClans, enqueued }`.

1. **Mark empty clans.** One `UPDATE clans SET priority_expiry_processed = true` for clans that are not deleted, have `priority_expires_at <= now`, are not processed, and have no `clan_members` row with `has_priority`. Nothing is audited or synced for them: there is nothing to remove from Admins.cfg.
2. **Find candidates.** `SELECT id, name, priority_expires_at` for clans that match the selection predicate and do have a `has_priority` member, ordered by `priority_expires_at` ascending.
3. If there are none, emit `clan_priority_expirer.run_ok` (`expired 0 clan priority windows`) and return `{ expiredClans: 0, enqueued: 0 }`.
4. Build the sync event: `reason: 'clan.priority.expire'`, `actor_player_id: null`, `enqueued_at` and `request_id: clan-priority-expirer:<now ISO>`.
5. **Expire in one transaction** (`expireClans`):
   1. `UPDATE clans SET priority_expiry_processed = true WHERE id IN (candidates) AND priority_expiry_processed = false AND priority_expires_at <= now AND deleted_at IS NULL RETURNING id`. The conditions are re-checked so a clan extended by `PATCH /api/v1/clans/:id/expire` after step 2 (which resets the flag and moves the deadline) is left untouched (#865).
   2. If no row was updated, stop with `{ expired: [], enqueued: 0 }`.
   3. Insert one `clan.priority.expire` audit row for each updated clan.
   4. Call `enqueueAdminsCfgSyncForAllServers`, which inserts one outbox row per active panel-hosted server. One event is enqueued per pass regardless of how many clans expired.
6. Emit `clan_priority_expirer.run_ok` with `{ expiredClans, enqueued }` counting only the clans the update changed.

Because the processed flag, audit rows and outbox rows commit together, a failure part-way (for example the audit insert) rolls everything back and the clans stay unprocessed for the next tick (#866).

## Failure handling

- Any error inside a tick emits `clan_priority_expirer.run_failed` (`error`, payload `{ err }`) and is rethrown. After the first tick, the kit logs it at `error` as `clan-priority-expirer tick failed` with `{ err }` and the interval keeps running.
- If the interval fires while the previous tick is still running, the new call is skipped and `previous clan-priority-expirer tick still running; skipping` is logged at `warn`.

## Downstream

`worker-config-sync` relays the outbox rows to the per-server admins-cfg-sync stream and rewrites the managed Admins.cfg segment. That segment is built from `clan_members` with `has_priority` in clans where `priority_expires_at IS NULL OR priority_expires_at > now()`, so expired clans drop out.

## Graceful shutdown (SIGTERM / SIGINT)

1. Clear the tick interval.
2. Emit `clan_priority_expirer.stopped` with `{ sig }`.
3. Stop the heartbeat.
4. `sql.end({ timeout: 5 })` (waits up to 5 s for in-flight queries), then `redis.quit()`.
5. Exit with code 0 (code 1 if the cleanup itself threw).

The kit's cleanup does not await a tick that is still running; it relies on the `sql.end` timeout for in-flight queries.
