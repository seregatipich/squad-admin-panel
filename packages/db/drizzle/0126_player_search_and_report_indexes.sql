-- Audit #71. The player search (`GET /api/v1/players?q=`, `/players/search`)
-- and the role-member search match `LIKE '%…%'`, which the existing btree
-- indexes on the normalized names cannot serve: every keystroke of a player
-- picker seq-scanned `players` and ran a correlated scan of
-- `player_name_history`. Trigram GIN indexes make those predicates indexable
-- (pg_trgm is already installed, see 0025).
--
-- Report analytics filter `player_reports` by a `created_at` window across all
-- statuses; the only index that starts with created_at's neighbour is
-- (status, created_at), so each window was a sequential scan.
--
-- Rollback-safe: indexes only; the previous release reads the same columns.
CREATE INDEX IF NOT EXISTS "players_canonical_name_normalized_trgm_idx"
  ON "players" USING gin ("canonical_name_normalized" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_name_history_name_normalized_trgm_idx"
  ON "player_name_history" USING gin ("name_normalized" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_reports_created_at_idx"
  ON "player_reports" USING btree ("created_at");
