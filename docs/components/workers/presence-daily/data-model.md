# worker-presence-daily - Data model

## Tables written

| Table | Operation | Writer function | Notes |
|---|---|---|---|
| `player_daily_presence` | `DELETE` the window, then `INSERT`; later `UPDATE` of `seed_seconds` | `recomputeDailyPresence`, `accrueDailyBonuses` | Primary key `(player_id, day, server_id)`. |
| `players` | `UPDATE` | `recomputeDailyPresence`, `accrueDailyBonuses` | `total_time_played_seconds` (and `updated_at`) from `player_sessions.duration_seconds`; `bonus_balance` (and `updated_at`) from accrual deltas. |
| `server_daily_stats` | `DELETE` the window, then `INSERT` | `recomputeServerDailyStats` | One row per non-deleted server per day, including days with no activity. This worker is the table's only writer. |
| `player_coplay` | `DELETE` the window, then `INSERT` | `recomputeCoplayWindow`, `recomputeCoplayForAllSessions` | One row per unordered player pair (`player_a_id < player_b_id`), server and UTC day. |
| `bonus_transactions` | `DELETE` and `INSERT` per day | `accrueDailyBonuses` | Types `earn_online`, `earn_boost`, `earn_seed` with `reference_type = 'daily_presence'` and `reference_id = <day>`; `adjust` rows when a shrinking accrual exceeds the player's balance. Not audited in `audit_log`. |

Every function runs its writes in one transaction (`sql.begin`), so a failure leaves the previous rows of that function intact.

## Tables read

- `player_sessions` (all recompute functions; pruned with a 2-day lower bound on `connected_at` unless the session is still open)
- `economy_settings` (`k_online`, `k_boost`, `k_seed`, `seed_threshold`, `economy_enabled`)
- `events` (kinds `server.seeding_started` and `server.seeding_ended`, to reconstruct seeding windows)
- `matches`, `chat_messages`, `combat_events`, `moderation_actions`, `players`, `servers`, `role_squad_permissions` (server daily stats)
- `player_daily_presence` (accrual aggregates the day's seconds per player)

## `player_daily_presence` row

Per player, server and UTC day: `online_seconds`, `boost_seconds`, `queue_seconds`, `seed_seconds`, `session_count`, summed from `player_sessions.mode` (`online`, `boost`, `queue`, `seed`). Open sessions end at `now`; sessions spanning midnight are split by UTC day; rows with no seconds are not written. `seed_seconds` is first written as 0 by the recompute, then replaced by accrual.

## Seed seconds attribution (accrual)

`accrueDailyBonuses` rewrites `seed_seconds` for the day regardless of `economy_enabled`. For a server that has ever emitted a seeding event, seed time is the intersection of the player's non-queue sessions with that server's reconstructed seeding windows; for servers with no seeding events it falls back to a concurrency sweep against `economy_settings.seed_threshold`. Because the day's rows are zeroed and rewritten, a change in attribution applies retroactively to every day still inside the window.

## Bonus ledger rewrite (accrual, economy enabled)

Per player with presence on the day, `amount = round(k * seconds / 3600)` for each of the three types, zero amounts skipped. The day's existing `earn_*` rows for those players are deleted and replaced and `bonus_balance` moves by the net delta. When a shrinking delta would take the balance below zero, the uncovered part is written as an `adjust` row (`reference = (player_id, day)`) and the balance stops at zero. When `economy_enabled` is false nothing is written to `bonus_transactions` or `bonus_balance`. A transaction-scoped advisory lock keyed by `economy-accrual:<day>` serialises concurrent accrual runs for the same day.

## `server_daily_stats` row

Per server and day: `avg_online`, `peak_online`, `avg_queue`, `online_seconds`, `matches`, `modes` (JSON), `maps` (JSON), `new_players`, `chat_messages`, `teamkills`, `punishments`, `avg_admins`, `peak_admins`, `computed_at`. Averages are time-weighted over the elapsed part of the day; peaks are exact maxima from an interval sweep over `player_sessions`. The full column semantics are documented in the header of `recomputeServerDailyStats` and in the schema file `packages/db/src/schema/server-daily-stats.ts`.

## Redis

- Writes `worker:heartbeat:presence-daily` (TTL 30 s).
- Appends to `diag:queue`.
