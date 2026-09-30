-- Indexes for the player-name substring searches and the report lists
-- (audit #40, #52, #71, #117, #138, #1328).
--
-- The player list, typeahead search, role-member search, users, votes,
-- leaderboards, suspects, combat events, clans, chat archive and event journal
-- filter with `LIKE '%q%'` on the normalised names. A B-tree cannot serve a
-- leading wildcard, so every search scanned `players` and
-- `player_name_history` in full. Trigram GIN indexes (pg_trgm) can; the
-- existing B-tree indexes stay for equality lookups.
--
-- Report analytics filter `player_reports` by a `created_at` window across all
-- statuses; reporter statistics, the reporter filter of the reports list and
-- in-game report dedup filter by reporter, and `handler_player_id` is an
-- ON DELETE SET NULL foreign key, so deleting a player scanned the table.
--
-- Rollback-safe: indexes only; the previous release reads the same columns and
-- simply may use them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx
  ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx
  ON player_name_history USING gin (name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_reports_created_at_idx
  ON player_reports USING btree (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_reports_reporter_created_idx
  ON player_reports (reporter_player_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_reports_handler_player_idx
  ON player_reports (handler_player_id);
