-- Substring player-name search (#69, finding #180). The leaderboard search,
-- the events player filter and the vote/history lookups match names with
-- `LIKE '%<query>%'`; the leading wildcard rules out the existing btree
-- indexes on these columns, so every search was a sequential scan of
-- `players` plus a correlated scan of `player_name_history`. pg_trgm GIN
-- indexes serve unanchored LIKE directly (the extension is already enabled by
-- 0025 for chat search; the CREATE EXTENSION below only guards a fresh DB).
--
-- Rollback-safe: additive indexes only; the previous release neither creates
-- nor depends on them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx
  ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx
  ON player_name_history USING gin (name_normalized gin_trgm_ops);
