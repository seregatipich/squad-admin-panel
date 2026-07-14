# worker-seed-reward

`worker-seed-reward` runs once at startup and then daily. It sums each player's
`player_daily_presence.seed_seconds` over the inclusive rolling 30-day UTC
window and reconciles `players.role_id` with the reward configured in
`economy_settings`.

Every grant or revocation is audited as system actor `seed-reward`, revokes the
player's panel sessions, and causes one Admins.cfg sync batch for active
servers. The worker publishes `worker:heartbeat:seed-reward` and
`seed_reward.*` diagnostic events.
