-- COMBAT-5 (#131): speed up moderation summaries and player widgets by offender.
CREATE INDEX IF NOT EXISTS combat_events_teamkill_attacker_idx
  ON combat_events (attacker_player_id, occurred_at DESC)
  WHERE is_teamkill;
