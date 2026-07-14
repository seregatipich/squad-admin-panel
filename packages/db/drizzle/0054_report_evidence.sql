-- REPORT-4 (#114): report_evidence link table — attaches media_files (MOD-3/VIDEO-1)
-- rows as evidence on a player_reports row submitted from the panel.
CREATE TABLE IF NOT EXISTS report_evidence (
  report_id      uuid        NOT NULL REFERENCES player_reports(id) ON DELETE CASCADE,
  media_file_id  uuid        NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, media_file_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS report_evidence_media_idx ON report_evidence (media_file_id);
