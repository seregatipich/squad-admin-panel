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

The worker publishes `worker:heartbeat:role-expirer` and `role_expirer.*`
diagnostic events (including `role_expirer.reminders_ok` /
`role_expirer.reminders_failed` for the reminder job).
