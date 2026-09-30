-- Issue #50 (#1073): link combat_events to matches.
--
-- 0029 declared combat_events.match_id as bigint with no FK, but matches.id is
-- a uuid (0024), so worker-log-ingest could never store the match it resolves
-- and match_id was always NULL; the API's matchId filter matched nothing.
-- match_uuid references matches(id) and is filled by log-ingest from now on;
-- the API filters and reports it as matchId. Historical rows stay NULL: the
-- match of an old event can still be derived from events.correlation_id.
--
-- Rollback-safe: added nullable column and index; the previous release never
-- names them. The dead bigint match_id stays in place (the previous release
-- still selects it) and is dropped in a later release.
ALTER TABLE combat_events
  ADD COLUMN IF NOT EXISTS match_uuid uuid REFERENCES matches(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_match_uuid_occurred_idx
  ON combat_events (match_uuid, occurred_at DESC)
  WHERE match_uuid IS NOT NULL;
