# Flows

## Expire Roles

`runRoleExpiryTick` reads up to 500 expired assignments ordered by
`role_expires_at`, clears them in one update, writes one audit row per player,
revokes sessions, and publishes a single Admins.cfg sync event for the batch.

The scan skips the system Owner role and any role an active VIP subscription
is about to renew: a subscription whose tier maps to the player's current role
and whose `next_renewal_at` is at most one day after `role_expires_at`. The
expiry tick runs every minute and the renewal tick hourly, so without this
guard a paying subscriber lost the role — and every panel session — at each
period boundary until the renewal re-granted it (#989). A `cancelled` or
`expired` subscription gives no protection; its paid period runs out normally.

Admins.cfg writing stays owned by `worker-config-sync`; this worker only
publishes the same stream contract as role mutation routes.
