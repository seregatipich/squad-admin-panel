-- REPORT-5: materialized per-reporter trust metrics. One row per reporter
-- player, recomputed by recomputeReporterStats() whenever one of their
-- reports changes status or gains/loses a linked moderation action.
-- Hand-authored (additive, fully idempotent) to mirror 0055_alt_detection.sql.

CREATE TABLE IF NOT EXISTS reporter_stats (
  player_id         uuid        NOT NULL,
  total_reports     integer     NOT NULL DEFAULT 0,
  resolved_reports  integer     NOT NULL DEFAULT 0,
  rejected_reports  integer     NOT NULL DEFAULT 0,
  confirmed_reports integer     NOT NULL DEFAULT 0,
  accuracy          real        NOT NULL DEFAULT 0,
  trusted           boolean     NOT NULL DEFAULT false,
  spam_flagged_at   timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reporter_stats_pkey PRIMARY KEY (player_id),
  CONSTRAINT reporter_stats_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reporter_stats_trusted_idx ON reporter_stats (trusted);
CREATE INDEX IF NOT EXISTS reporter_stats_spam_idx ON reporter_stats (spam_flagged_at);
