# Troubleshooting

## Expired Roles Remain Assigned

Check `worker:heartbeat:role-expirer`, then inspect `role_expirer.run_failed`
events in diagnostics. Common causes are missing migrations, unavailable
Postgres, or unavailable Redis.

## Admins.cfg Does Not Update

`worker-role-expirer` only enqueues sync events. Check `worker-config-sync`
heartbeat and Admins.cfg sync stream diagnostics if roles are cleared in the DB
but server config remains stale.
