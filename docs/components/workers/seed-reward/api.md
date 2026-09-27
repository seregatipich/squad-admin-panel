# API

The worker has no direct HTTP API. Reward configuration is read and written
through `GET` and `PUT /api/v1/settings/economy`:

- `seed_reward_threshold_hours_per_month` is a finite number from 0 through 720.
  It must be above 0 whenever a reward role is set: a request that edits the
  reward with a role and a zero threshold is rejected with HTTP 422
  `seed_reward_threshold_required`.
- `seed_reward_role_id` is a role UUID or `null` to disable automation.

Saving rejects missing roles and roles with `panel_access=true` with HTTP 422.
Changing either reward field requires `can_edit_roles`.
