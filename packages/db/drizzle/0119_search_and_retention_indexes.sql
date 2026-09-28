-- Issue #52: indexes for the queries that actually run.
--
-- Nickname search is `LIKE '%…%'` on players.canonical_name_normalized and
-- player_name_history.name_normalized (players list and autocomplete,
-- leaderboards, suspects, chat, events, votes, …). A B-tree cannot serve a
-- leading wildcard, so every search scanned both tables; trigram GIN indexes
-- (pg_trgm, installed by 0025) can. The existing B-tree indexes stay: they
-- still serve equality lookups.
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx
  ON player_name_history USING gin (name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx
  ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
-- Reporter statistics, the reporter filter of the reports list and in-game
-- report dedup all filter player_reports by reporter; the handler column is an
-- ON DELETE SET NULL foreign key, so deleting a player scanned the table.
CREATE INDEX IF NOT EXISTS player_reports_reporter_created_idx
  ON player_reports (reporter_player_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_reports_handler_player_idx
  ON player_reports (handler_player_id);
--> statement-breakpoint
-- processed_events is now pruned by worker-event-partition on processed_at;
-- the (group_name, processed_at) index was never used by any query.
CREATE INDEX IF NOT EXISTS processed_events_processed_at_idx
  ON processed_events (processed_at);
--> statement-breakpoint
DROP INDEX IF EXISTS processed_events_group_idx;
--
-- Rollback-safe: only indexes change. The previous release never relied on
-- processed_events_group_idx, and extra indexes are invisible to it.
