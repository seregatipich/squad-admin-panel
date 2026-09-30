-- Trigram indexes for the player-name substring searches (#40, finding #1328).
--
-- The player list, typeahead search, users, votes, leaderboards, suspects,
-- combat-events, clans and role-members routes all filter with
-- `canonical_name_normalized LIKE '%q%'` (players/search and the list also
-- check `player_name_history.name_normalized`). A leading wildcard cannot use
-- the existing btree indexes, so each search scanned both tables in full.
--
-- Rollback-safe: additive indexes only; the previous release's queries are
-- unchanged and simply may use them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_trgm_idx
  ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_trgm_idx
  ON player_name_history USING gin (name_normalized gin_trgm_ops);
