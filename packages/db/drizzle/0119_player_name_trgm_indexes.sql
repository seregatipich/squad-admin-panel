-- Trigram indexes for the nickname searches of the chat archive, event
-- journal, votes and combat events (audit #117/#138). They filter with
-- `LIKE '%query%'` on the normalised names; the existing btree indexes cannot
-- serve a leading wildcard, so every search was a sequential scan.
--
-- Rollback-safe: adds indexes only; the previous release ignores them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx ON player_name_history USING gin (name_normalized gin_trgm_ops);
