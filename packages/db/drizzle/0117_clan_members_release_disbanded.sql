-- Release players stranded in disbanded clans (#14). Disbanding used to
-- soft-delete the clan and keep its clan_members rows; because
-- clan_members_player_unique_idx is global, those players could never join
-- another clan again. DELETE /api/v1/clans/:id now removes the roster itself
-- (recording it in the clan.disband audit snapshot); this clears the rows the
-- old behaviour left behind.
--
-- Rollback-safe: no schema change. The previous release never reads the
-- roster of a soft-deleted clan (every clan route loads active clans only).
DELETE FROM clan_members cm
  USING clans c
  WHERE c.id = cm.clan_id
    AND c.deleted_at IS NOT NULL;
