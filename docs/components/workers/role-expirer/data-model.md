# Data Model

The worker owns no tables. It reads and writes the tables below through
`@squad/db`; the schema files live in
[`packages/db/src/schema/`](../../../../packages/db/src/schema/).

## Expiry tick

| Table | Access | Columns |
|---|---|---|
| `players` | read | `id`, `role_id`, `role_expires_at`, `role_comment` |
| `roles` | read (join) | `id`, `name`, `is_system_role` |
| `vip_subscriptions` | read (guard) | `player_id`, `tier_id`, `status`, `next_renewal_at` |
| `vip_tiers` | read (guard) | `id`, `role_id` |
| `players` | write | Sets `role_id`, `role_expires_at` and `role_comment` to NULL and `updated_at` to the tick time, guarded by `id`, `role_id` and `role_expires_at` still matching what was scanned. |
| `audit_log` | insert | One row per cleared player: `action_type = 'player.role.expire'`, `actor_kind = 'system'`, `actor_system_label = 'role-expirer'`, `target_type = 'player'`, `target_id`, `before_snapshot` (`role_id`, `role_expires_at`, `role_comment`), `after_snapshot` (all three NULL), `context` (`expired_at`), `status_code = 200`. |
| `sessions` | delete | Every row with the player's `player_id`; the deleted `id` values drive the Redis fan-out. |
| `admins_cfg_sync_outbox` | insert | One row per non-deleted server with `runtime = 'container'`, via `enqueueAdminsCfgSyncForAllServers`. Columns written: `server_id`, `payload`. |

The scan selects at most 500 rows (`createRoleExpiryDeps` default), ordered by
`role_expires_at` ascending. It skips the role named `Owner` when
`is_system_role` is true, and any player with an `active` subscription whose
tier `role_id` equals the player's current `role_id` and whose `next_renewal_at`
is at most one day after `role_expires_at`.

The per-player update, the audit insert, the session delete and the outbox
insert run in one transaction. A player whose update matches no row (a renewal
or edit won the race) is skipped without audit, session delete or outbox row.

## Reminder tick

| Table | Access | Columns |
|---|---|---|
| `economy_settings` | read | `vip_expiry_windows_days` where `id = 1`; falls back to `[7, 3, 1]` when the row or value is missing. |
| `players` | read | `id`, `canonical_name`, `role_id`, `role_expires_at` for rows with `role_expires_at` in `(now, now + largest window]`. |
| `roles` | read (join) | `id`, `name` |
| `expiry_notifications` | insert | `player_id`, `role_id`, `expires_at`, `window_days`, `recipient`. `ON CONFLICT DO NOTHING` on the unique index `expiry_notifications_assignment_window_recipient_key`. |
| `expiry_notifications` | update | `alert_event_id` on the `admin` row, set in the same transaction as the alert insert. |
| `alert_events` | insert | `rule_id = ROLE_EXPIRY_ALERT_RULE_ID` (`00000000-0000-7000-8000-000000000170`), `severity = 'info'`, `payload` (the `role_expiring` shape). |

Configured windows are normalised to integers from 1 through 90, deduplicated
and sorted descending; any other value is dropped. The scan selects at most
1000 rows (`createRoleExpiryReminderDeps` default). For each grant the smallest
window not smaller than the remaining time is chosen.

Each grant yields up to two `expiry_notifications` rows:

- `recipient = 'admin'`: claimed together with the `alert_events` row in one
  transaction. Only this claim triggers the live-bus frame.
- `recipient = 'player'`: claimed after the admin claim. It stays pending
  (`queued_at IS NULL`) until `worker-log-ingest` sends the in-game `AdminWarn`
  on the player's next connect and stamps `queued_at`. The worker records this
  row regardless of `economy_settings.vip_expiry_warn_in_game`; log-ingest reads
  that flag when it delivers.

`expiry_notifications.role_id` has no foreign key, so deleting a role never
blocks on reminder history. The table has CHECK constraints keeping `recipient`
in (`admin`, `player`) and `window_days` between 1 and 90.

## Renewal tick

| Table | Access | Columns |
|---|---|---|
| `vip_subscriptions` | read | `id`, `player_id`, `tier_id`, `status`, `renews_every_days`, `price_bonuses`, `next_renewal_at` for rows with `status = 'active'` and `next_renewal_at <= now`, oldest first, at most 500, via index `vip_subscriptions_due_idx`. |
| `vip_tiers` | read (join) | `name`, `role_id` (read from the tier at renewal time). |
| `players` | read (join) | `canonical_name` |
| `roles` | read | `panel_access`, `is_system_role` of the tier role (escalation guard). |
| `players` | read `FOR UPDATE`, write | `applyVipGrant` locks the row, then writes `bonus_balance`, `role_id`, `role_expires_at`, `updated_at`. |
| `bonus_transactions` | insert | `player_id`, `amount = -price`, `type = 'spend'`, `reference_type = 'vip_subscription'`, `reference_id = <subscription id>`, `actor_player_id = NULL`. Skipped when the price is 0. |
| `vip_subscriptions` | update | `next_renewal_at` advanced by `renews_every_days` from the due date, guarded by `id`, `status = 'active'` and `next_renewal_at` equal to the scanned value. |
| `admins_cfg_sync_outbox` | insert | One row per container server, inside the charge transaction. |
| `audit_log` | insert | `player.subscription.renew` inside the charge transaction: `before_snapshot` (`next_renewal_at`), `after_snapshot` (`next_renewal_at`, `role_expires_at`, `bonus_balance`), `context` (`subscription_id`, `tier_id`, `price_bonuses`, `renewed_at`). |

On a failed renewal (a status other than `ok`) the worker runs separate, non
transactional statements:

| Table | Access | Columns |
|---|---|---|
| `vip_subscriptions` | update | `status = 'expired'`, `cancelled_at = now`, guarded by `status = 'active'`. |
| `audit_log` | insert | `player.subscription.expire` with `before_snapshot` `{ status: 'active' }`, `after_snapshot` `{ status: 'expired' }` and `context` (`subscription_id`, `tier_id`, `reason`, `price_bonuses`, `expired_at`). |
| `alert_events` | insert | `rule_id = ROLE_EXPIRY_ALERT_RULE_ID`, `severity = 'warning'`, `payload` (the `subscription_expired` shape). |

The seeded alert rule is named `Истечение VIP` and is created by migration
`0092_vip_expiry_reminders.sql`. `vip_subscriptions` also carries a partial
unique index `vip_subscriptions_one_active_idx`, so a player has at most one
`active` subscription.

## Redis

No keys beyond those listed in [api.md](api.md): the heartbeat, `diag:queue`,
`session:<sessionId>` deletions and the `live-bus` channel.
