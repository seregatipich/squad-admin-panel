-- SEED-2 (#141): materialized seed session intervals and automatic reward settings.
ALTER TABLE player_sessions DROP CONSTRAINT IF EXISTS player_sessions_mode_chk;
ALTER TABLE player_sessions
  ADD CONSTRAINT player_sessions_mode_chk
  CHECK (mode IN ('online', 'boost', 'queue', 'seed'));

ALTER TABLE economy_settings
  ADD COLUMN IF NOT EXISTS seed_reward_threshold_hours_per_month double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seed_reward_role_id uuid REFERENCES roles(id) ON DELETE SET NULL;

ALTER TABLE economy_settings
  DROP CONSTRAINT IF EXISTS economy_settings_seed_reward_threshold_range;
ALTER TABLE economy_settings
  ADD CONSTRAINT economy_settings_seed_reward_threshold_range
  CHECK (
    seed_reward_threshold_hours_per_month >= 0
    AND seed_reward_threshold_hours_per_month <= 720
  );
