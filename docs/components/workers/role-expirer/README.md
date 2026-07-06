# worker-role-expirer

`worker-role-expirer` removes temporary panel roles after `players.role_expires_at`
passes. Each tick:

1. Finds players with `role_id IS NOT NULL` and expired `role_expires_at`.
2. Clears `role_id`, `role_expires_at`, and `role_comment`.
3. Writes `player.role.expire` audit rows as system actor `role-expirer`.
4. Revokes panel sessions for affected players.
5. Enqueues Admins.cfg sync for every active server.

The worker publishes `worker:heartbeat:role-expirer` and `role_expirer.*`
diagnostic events.
