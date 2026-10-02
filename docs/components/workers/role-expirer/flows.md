# Flows

## Expire Roles

`runRoleExpiryTick` reads up to 500 expired assignments ordered by
`role_expires_at`. In one transaction it clears each assignment with a guarded
update (skipping any row that changed since the scan), writes one audit row per
cleared player, deletes that player's sessions, and inserts one
`admins_cfg_sync_outbox` row per non-deleted container server for the batch.
After the commit it deletes the `session:<id>` Redis keys and publishes
`session.revoked` frames to the `live-bus` channel; a failure there is
reported as `role_expirer.session_notify_failed` and does not undo the expiry.

The scan skips the system Owner role and any role an active VIP subscription
is about to renew: a subscription whose tier maps to the player's current role
and whose `next_renewal_at` is at most one day after `role_expires_at`. The
expiry tick runs every minute and the renewal tick hourly, so without this
guard a paying subscriber lost the role — and every panel session — at each
period boundary until the renewal re-granted it (#989). A `cancelled` or
`expired` subscription gives no protection; its paid period runs out normally.

Admins.cfg writing stays owned by `worker-config-sync`; this worker only
inserts outbox rows, which `worker-config-sync` relays to
`events:admins-cfg-sync:<serverId>`, the same path role mutation routes use.

## Scheduling

`runWorker` runs the expiry, reminder and renewal passes once at startup, in
that order, and then arms one interval per pass. A pass that is still running
when its interval fires is skipped. A failure of the startup expiry pass aborts
the worker with exit code 1; a failure of the startup reminder or renewal pass
is logged and the worker carries on.
