# Troubleshooting

## Rewards Do Not Change

Check `worker:heartbeat:seed-reward`, then inspect `seed_reward.run_failed`
diagnostics. Confirm the reward role is configured, has no panel access, and
`player_daily_presence.seed_seconds` contains rows inside the last 30 UTC days.

## Admins.cfg Does Not Update

This worker only enqueues sync events. Check `worker-config-sync` and the
`events:admins-cfg-sync:{serverId}` stream if database roles changed but the
server configuration did not.
