# worker-clan-guard - Troubleshooting

## An impostor is not warned

**Diagnostic:**

```bash
redis-cli GET worker:heartbeat:clan-guard
docker compose logs worker-clan-guard --since 10m | grep -E 'clan-guard|failed'
```

```sql
SELECT enabled, grace_period_seconds FROM clan_guard_settings WHERE id = 1;
SELECT id, name, tags, is_tag_protected, deleted_at FROM clans WHERE name = '<clan name>';
```

**Possible causes (check in this order):**

1. The kill-switch is off: `enabled = false`. Every tick emits `clan_guard.skipped_disabled` and the log line shows `skipped: true`.
2. The clan is not protected (`is_tag_protected = false`) or is soft-deleted.
3. The tag does not match the start of the name. Only a prefix counts (`Player [ABC]` never matches), and a bare tag must be followed by a non-letter, non-digit character or the end of the name (`ALT` does not match `Altair`). See [flows.md](./flows.md).
4. The player is a member of that clan (`clan_members`), so wearing the tag is allowed.
5. The player has no open online session (`player_sessions.disconnected_at IS NULL AND mode = 'online'`) or no `players.eos_id`; those players are skipped silently.
6. The worker is not running (heartbeat key absent) or its ticks fail: look for `clan-guard tick failed`.

## Warned but never kicked

- The player holds a role with `panel_access = true`: such players are re-warned on every tick after the grace period and never kicked, by design.
- The grace period has not elapsed since the first warn of this session (`grace_period_seconds`, default 300). Check the warn row: `SELECT created_at FROM moderation_actions WHERE player_id = '<id>' AND action_type = 'clan_tag_protection' ORDER BY created_at DESC;`.
- Commands are fire-and-forget. Check that `worker-rcon` is consuming `rcon:commands:<serverId>` (`redis-cli XLEN rcon:commands:<serverId>`, then the rcon worker's logs and results); a kick that is appended but not executed shows up as `kicked` in the tick log with no effect in game.

## The same player is warned or kicked repeatedly

- A rejoin (new `connected_at`) restarts the cycle with a fresh warn, by design.
- A kick is re-enqueued on every tick while the player is still connected; only the first is recorded in `moderation_actions` and `audit_log`. A player who stays online after a recorded kick means the RCON command is not being executed.
- If a ledger or audit insert failed after the RCON enqueue, no warn row exists and the next tick sends the first warn again. Look for `clan_guard.player_failed` diagnostics.

## `clan_guard.player_failed` events

The payload holds `playerId`, `serverId` and `err`. Typical causes are a rejected `rconCommandRequestSchema` validation (an argument over 1024 characters), a Redis error on `XADD`, or a database error on the ledger/audit insert. The failure affects one player; the rest of the tick continues, and the tick log reports it in `errors`.

## Worker restarts in a loop

`DATABASE_URL is required` or `REDIS_URL is required` in the logs means a missing variable (exit code 1). A failure of the first tick (for example Postgres unreachable or the `clan_guard_settings` table missing because migrations did not run) is also fatal and exits with code 1. An invalid `CLAN_GUARD_INTERVAL_MS` throws `CLAN_GUARD_INTERVAL_MS must be a positive integer, got "<value>"` at startup.

## `previous clan-guard tick still running; skipping`

A tick took longer than the interval (120 s by default). The skipped call is dropped. The tick makes one query per `findLastWarn` / `hasRecordedKick` per matching player, so a very slow database is the usual cause.

## Useful commands

```bash
docker compose logs worker-clan-guard -f --since 2m
redis-cli GET worker:heartbeat:clan-guard
redis-cli XREVRANGE rcon:commands:<serverId> + - COUNT 5
```
