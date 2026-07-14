ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS report_id uuid REFERENCES player_reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS moderation_actions_report_idx
  ON moderation_actions (report_id);
