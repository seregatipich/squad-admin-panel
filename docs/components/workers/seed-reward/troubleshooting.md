# Troubleshooting

## Rewards Do Not Change

Check `worker:heartbeat:seed-reward`, then inspect `seed_reward.run_failed`
diagnostics. Confirm the reward role is configured, has no panel access, the
monthly threshold is above 0, and `player_daily_presence.seed_seconds` contains
rows inside the last 30 UTC days. A player who already holds any other role
never receives the reward.

## Admins.cfg Does Not Update

This worker only enqueues sync events. Check `worker-config-sync` and the
`events:admins-cfg-sync:{serverId}` stream if database roles changed but the
server configuration did not.
