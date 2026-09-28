-- See packages/db/sql/events-seeding-kind.sql (#1324).
--
-- Rollback-safe: an additional index; the previous release ignores it.
CREATE INDEX IF NOT EXISTS events_seeding_kind_occurred_idx
  ON events (kind, occurred_at DESC)
  INCLUDE (server_id)
  WHERE kind IN ('server.seeding_started', 'server.seeding_ended');
