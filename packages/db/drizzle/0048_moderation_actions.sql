CREATE TABLE IF NOT EXISTS moderation_actions (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  author_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  author_system_label text,
  reason text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz,
  reverted_by uuid REFERENCES players(id) ON DELETE SET NULL,
  CONSTRAINT moderation_actions_author_present
    CHECK (author_player_id IS NOT NULL OR author_system_label IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS moderation_actions_player_created_idx
  ON moderation_actions (player_id, created_at);
CREATE INDEX IF NOT EXISTS moderation_actions_action_type_idx
  ON moderation_actions (action_type, created_at);
CREATE INDEX IF NOT EXISTS moderation_actions_server_created_idx
  ON moderation_actions (server_id, created_at);
