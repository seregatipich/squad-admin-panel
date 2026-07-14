# Flows

## Reconcile Rewards

1. Resolve the inclusive 30-day UTC window ending today.
2. Read the configured threshold and reward role; stop when no role is configured.
3. Refuse to run if the configured role currently grants panel access.
4. Sum seed seconds per player and transactionally grant at or above the threshold or revoke below it.
5. Write one system audit row per changed player.
6. Revoke changed players' sessions and enqueue one Admins.cfg sync batch.

Revocation only removes the configured reward role. A manual role assigned
after a reward grant is not removed when the player later falls below the
threshold.
