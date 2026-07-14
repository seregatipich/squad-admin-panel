-- ROT-4 (#147): one-off rotation calendar changes and server-local weekly
-- managed-segment profiles. The scheduler executes rotation_schedule rows;
-- profile rows are applied to LayerRotation.cfg at the server's local 04:00.
CREATE TABLE IF NOT EXISTS rotation_schedule (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  layer text NOT NULL,
  mode text NOT NULL DEFAULT 'set_next',
  created_by uuid REFERENCES players(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rotation_schedule_mode_check CHECK (mode IN ('set_next', 'force_change'))
);
CREATE INDEX IF NOT EXISTS rotation_schedule_server_scheduled_idx
  ON rotation_schedule (server_id, scheduled_at);

CREATE TABLE IF NOT EXISTS rotation_profiles (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  weekday smallint,
  layers text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES players(id) ON DELETE SET NULL,
  last_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rotation_profiles_weekday_check CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6))
);
CREATE INDEX IF NOT EXISTS rotation_profiles_server_weekday_idx
  ON rotation_profiles (server_id, weekday);
CREATE UNIQUE INDEX IF NOT EXISTS rotation_profiles_server_default_key
  ON rotation_profiles (server_id) WHERE weekday IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rotation_profiles_server_weekday_key
  ON rotation_profiles (server_id, weekday) WHERE weekday IS NOT NULL;
