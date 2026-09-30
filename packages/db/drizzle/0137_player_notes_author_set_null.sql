-- Issue #78 (audit w4-49, finding 1137). Expand-only: a constraint relaxed on
-- one column, no data touched, so the previous release keeps working against
-- the new schema (its inner joins on the author simply skip a note whose author
-- was deleted, and its writes always supply an author).
--
-- Notes are historical records (they have their own soft delete), so deleting
-- the player who wrote one must not delete the note: author_id becomes
-- nullable and its foreign key ON DELETE SET NULL, like deleted_by and the
-- moderation_actions authors.
ALTER TABLE player_notes ALTER COLUMN author_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE player_notes DROP CONSTRAINT IF EXISTS player_notes_author_id_players_id_fk;
--> statement-breakpoint
ALTER TABLE player_notes
  ADD CONSTRAINT player_notes_author_id_players_id_fk
  FOREIGN KEY (author_id) REFERENCES players(id) ON DELETE SET NULL;
