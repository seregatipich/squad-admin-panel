# Flows

## Reconcile Rewards

1. Resolve the inclusive 30-day UTC window ending today.
2. Read the configured threshold and reward role; stop when no role is configured
   or the threshold is 0 (a zero threshold would qualify every player).
3. Refuse to run if the configured role currently grants panel access.
4. Sum seed seconds per player and transactionally grant at or above the threshold
   to players who hold no role, or revoke below it from players who hold the reward role.
5. Write one system audit row per changed player.
6. Revoke changed players' sessions and enqueue one Admins.cfg sync batch.

Grants and revocations never touch a manually assigned role: a qualifying
player who already holds any role (Owner, staff, VIP, a time-bounded grant)
keeps it, and revocation only removes the configured reward role. A manual role
assigned after a reward grant is not removed when the player later falls below
the threshold.
