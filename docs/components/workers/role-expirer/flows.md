# Flows

## Expire Roles

`runRoleExpiryTick` reads up to 500 expired assignments ordered by
`role_expires_at`, clears them in one update, writes one audit row per player,
revokes sessions, and publishes a single Admins.cfg sync event for the batch.

Admins.cfg writing stays owned by `worker-config-sync`; this worker only
publishes the same stream contract as role mutation routes.
