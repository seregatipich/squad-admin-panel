# worker-role-expirer

`worker-role-expirer` removes temporary panel roles after `players.role_expires_at`
passes. Each tick:

1. Finds players with `role_id IS NOT NULL` and expired `role_expires_at`.
2. Clears `role_id`, `role_expires_at`, and `role_comment`.
3. Writes `player.role.expire` audit rows as system actor `role-expirer`.
4. Revokes panel sessions for affected players.
5. Enqueues Admins.cfg sync for every active server.

A second, daily reminder job (VIPSUB-4, #170) warns about upcoming expiries
before the main tick removes them. Each reminder tick:

1. Loads the reminder windows from `economy_settings.vip_expiry_windows_days`
   (default `[7, 3, 1]` days).
2. Finds active grants whose `role_expires_at` falls inside a window and picks
   the smallest crossed window per grant.
3. Claims a `(player, role, expires_at, window, recipient)` row in
   `expiry_notifications` (`ON CONFLICT DO NOTHING`) so each window fires at
   most once; renewing a grant re-arms the windows because `expires_at` is
   part of the unique key.
4. On a successful claim, inserts one broadcast `role_expiring` `alert_events`
   row (rule `Истечение VIP`, seeded by migration 0092) and publishes the
   matching `alert.triggered` live-bus frame — visible only to admins with
   `can_assign_roles`.
5. Records a pending `player` row that worker-log-ingest turns into a one-shot
   in-game `AdminWarn` on the player's next connect (disabled via
   `economy_settings.vip_expiry_warn_in_game`).

A third, hourly job (VIPSUB-5, #171) bills recurring VIP subscriptions. Each
renewal tick:

1. Selects `vip_subscriptions` rows with `status = 'active'` and
   `next_renewal_at <= now` (index `vip_subscriptions_due_idx`).
2. For each, charges the row's **snapshot** `price_bonuses` via the shared
   `applyVipGrant` helper in `@squad/db`: one `bonus_transactions` `spend` row,
   the new balance, and `players.role_expires_at` pushed forward by
   `renews_every_days` from the later of now and the current expiry.
3. Advances `next_renewal_at` by one period **from the date that was due**, not
   from the wall clock, so an outage does not shift the billing schedule.
4. If the balance cannot cover the price (or the tier's role can no longer be
   granted), flips the row to `expired`, writes a `player.subscription.expire`
   audit row, records a broadcast `alert_events` row on the seeded
   `role_expiring` rule with `event_kind: 'subscription_expired'`, and publishes
   the matching `alert.triggered` live-bus frame. The role itself is **not**
   removed here — the already-paid period runs out first and the main tick
   removes it on schedule.
5. Enqueues one Admins.cfg sync for the whole run, not one per subscription.

A subscription cancelled between the scan and the charge is skipped and nothing
is billed. One failing subscription never aborts the batch.

The worker publishes `worker:heartbeat:role-expirer` and `role_expirer.*`
diagnostic events (including `role_expirer.reminders_ok` /
`role_expirer.reminders_failed` for the reminder job and
`role_expirer.renewals_ok` / `role_expirer.renewals_failed` for the renewal
job).
