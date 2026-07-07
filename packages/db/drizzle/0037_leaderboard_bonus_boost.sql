-- LEAD-4: economy leaderboard columns on player_stat_periods.
-- Adds boost_seconds (materialised from player_daily_presence.boost_seconds) and
-- bonus_points (accrued by the aggregator worker as k_online * online + k_boost *
-- boost, coefficients from economy_settings at recompute time). Closed periods are
-- never re-passed to the aggregator, so a coefficient change only affects the open
-- periods still inside the recompute window — past bonuses stay frozen. Both columns
-- and their descending indexes are additive and idempotent.

ALTER TABLE player_stat_periods
  ADD COLUMN IF NOT EXISTS boost_seconds integer NOT NULL DEFAULT 0;

ALTER TABLE player_stat_periods
  ADD COLUMN IF NOT EXISTS bonus_points numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'player_stat_periods_economy_chk'
      AND conrelid = 'player_stat_periods'::regclass
  ) THEN
    ALTER TABLE player_stat_periods
      ADD CONSTRAINT player_stat_periods_economy_chk
      CHECK (boost_seconds >= 0 AND bonus_points >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS player_stat_periods_boost_idx
  ON player_stat_periods (period_type, period_start, server_id, boost_seconds DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_bonus_idx
  ON player_stat_periods (period_type, period_start, server_id, bonus_points DESC);
