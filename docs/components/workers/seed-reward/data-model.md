# Data Model

The worker reads `economy_settings.seed_reward_threshold_hours_per_month`,
`economy_settings.seed_reward_role_id`, and the last 30 UTC dates from
`player_daily_presence.seed_seconds`.

It writes `players.role_id`, clears `players.role_expires_at` and
`players.role_comment`, and creates `audit_log` actions
`seed.reward_granted` or `seed.reward_revoked`. Deleting the configured role
sets `seed_reward_role_id` to null through its foreign key.
