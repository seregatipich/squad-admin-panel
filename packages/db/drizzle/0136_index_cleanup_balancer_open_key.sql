-- Issue #78 (audit w4-49). Expand-only and idempotent; safe for a rollback to
-- the release before it (no column or table is touched).
--
-- 1. Indexes no query reads (#1124, #1125, #1136, #1141): each one only adds
-- write cost. external_bans_dedup_key already leads with source_id; the
-- reporter_stats indexes cover lone boolean / nullable flags the planner never
-- picks; sessions are read by player_id or id, never scanned by activity;
-- media_upload_tokens is read by token_hash; diagnostic_events has no reader
-- at all beyond the ts index that retention rotation uses.
DROP INDEX IF EXISTS external_bans_source_id_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS reporter_stats_trusted_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS reporter_stats_spam_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS sessions_last_activity_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS media_upload_tokens_expires_at_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS diagnostic_events_server_ts_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS diagnostic_events_kind_ts_idx;
--> statement-breakpoint

-- 2. One open balancer snapshot per (server_id, mode) (#1117). The ingest
-- route serialises deliveries with an advisory lock; this makes the invariant
-- hold in the database too. Rows that already violate it are resolved first:
-- the newest open snapshot stays open, older ones become superseded.
UPDATE balancer_proposals AS older
SET status = 'superseded'
WHERE older.status = 'open'
  AND EXISTS (
    SELECT 1 FROM balancer_proposals AS newer
    WHERE newer.server_id = older.server_id
      AND newer.mode = older.mode
      AND newer.status = 'open'
      AND (newer.generated_at, newer.id) > (older.generated_at, older.id)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS balancer_proposals_open_key
  ON balancer_proposals (server_id, mode)
  WHERE status = 'open';
