# worker-clan-guard - Flows

## Startup

`runWorker` (from `@squad/worker-kit`) performs:

1. Read `DATABASE_URL` and `REDIS_URL`; a missing one is fatal (exit 1). Open the Postgres pool and a Drizzle client, and connect Redis.
2. Start the heartbeat (`worker:heartbeat:clan-guard`, every 5 s) and create the diag emitter.
3. Build the tick from `setup()` (which passes the Drizzle client and the Redis connection to `createClanGuardDeps`) and install the SIGINT/SIGTERM handlers.
4. Emit `clan_guard.started` with `{ pid }`.
5. Run one tick immediately. A failure of this first tick is fatal: the process logs `fatal` and exits with code 1 (the kit's default `firstRunFailure`).
6. Mark the worker ready and arm a `setInterval` of `CLAN_GUARD_INTERVAL_MS`.

A SIGTERM received before step 6 completes is remembered; shutdown runs after the first tick and the interval is never armed.

## Tag matching

`matchProtectedTag(rawName, tag)` trims and lower-cases both values, returns `false` for an empty tag, and only considers the **start** of the name (`Player [ABC]` never matches `[ABC]`):

- Plain prefix: the name starts with the tag. If the tag's last character is a letter or digit, the next character in the name must not be a letter or digit (or the name must end there). So bare `ALT` matches `ALT Player`, `alt|Player`, `RU_Impostor` and `  RU`, but not `Altair`, `rush_pro`, `RU2Player` or `Русич` (for `РУ`). A tag stored with its own trailing symbol (`[ABC]`, `=ALT=`) is matched as a plain prefix.
- Re-wrapped: the name starts with the tag wrapped in `[]`, `()`, `<>` or `{}`, so bare `TST` matches `[TST] Impostor`.

`findImpostorMatch` walks the protected clans in load order, skips every clan whose member set contains the player, and returns the first clan/tag pair that matches.

## Enforcement tick

1. Load settings. If `enabled` is false, emit `clan_guard.skipped_disabled` and return `{ skipped: true, warned: 0, kicked: 0, errors: 0 }` without further queries.
2. Load protected clans. If there are none, return `{ skipped: false, warned: 0, kicked: 0, errors: 0 }` without loading players.
3. Load online players. For each player, in order:
   1. Skip a player without `eos_id`.
   2. Run `findImpostorMatch` on the player's name; skip when there is no match.
   3. Look up the latest `warn` ledger row of this session (`findLastWarn`) and build the message.
   4. **No warn yet:** enqueue `AdminWarn` with `[eos_id, message]`, insert the `warn` ledger row, insert the `clan.tag_protection.warn` audit row, `warned += 1`.
   5. **Warn younger than the grace period** (`(now - warn.created_at) / 1000 < grace_period_seconds`): do nothing.
   6. **Grace period elapsed and the player's role has `panel_access`:** enqueue another `AdminWarn`, `warned += 1`. No ledger or audit row is written for the repeat.
   7. **Grace period elapsed otherwise:** enqueue `AdminKick`. If a `kick` ledger row already exists for this session, `kicked += 1` and stop; otherwise insert the `kick` ledger row and the `clan.tag_protection.kick` audit row, then `kicked += 1`.
   8. Any exception in steps 3 to 7 increments `errors`, emits `clan_guard.player_failed`, and the loop continues with the next player.
4. Return `{ skipped: false, warned, kicked, errors }`. The kit logs it at `info` as `clan-guard tick`.

Consequences worth knowing:

- Commands are fire-and-forget: success means the entry was appended to `rcon:commands:<serverId>`, not that the server executed it. While the player stays connected the `AdminKick` is enqueued again on every tick (and `kicked` is incremented every time), but only the first one is recorded in the ledger and audit log.
- The `AdminWarn` for a panel-access holder is repeated on every tick after the grace period, because the reference warn is the first one of the session.
- The ledger and audit inserts happen after the RCON enqueue and are not transactional. If the ledger insert fails after a successful enqueue, the player is counted as an error and the next tick (finding no warn row) sends the first warn again.
- A grace period of 0 turns the second detection into a kick.

## Failure handling

- A failure outside the per-player `try` (for example loading settings) rejects the tick. After the first tick the kit logs `clan-guard tick failed` with `{ err }` at `error` and keeps the interval running. There is no `run_failed` diagnostic event for this worker.
- If the interval fires while the previous tick is running, the call is skipped and `previous clan-guard tick still running; skipping` is logged at `warn`.

## Graceful shutdown (SIGTERM / SIGINT)

1. Clear the tick interval.
2. Emit `clan_guard.stopped` with `{ sig }`.
3. Stop the heartbeat.
4. `sql.end({ timeout: 5 })`, then `redis.quit()`.
5. Exit with code 0 (code 1 if the cleanup itself threw).
