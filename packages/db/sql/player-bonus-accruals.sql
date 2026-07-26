-- player_bonus_accruals (ECON-5 #165): precomputed rolling 30-day bonus
-- accrual window per player. Plain aggregate table (house pattern, not a
-- materialized view) fully rebuilt by the leaderboard-aggregator tick via
-- recomputeBonusAccruals — a DELETE + INSERT…SELECT over the earn_* rows of
-- bonus_transactions. Backs GET /api/v1/leaderboards/bonuses?period=30d.
-- This file mirrors packages/db/src/schema/player-bonus-accruals.ts and is
-- fully idempotent so it can be re-applied by the integration tests.

CREATE TABLE IF NOT EXISTS player_bonus_accruals (
  player_id   uuid        PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  accrued_30d integer     NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_bonus_accruals_nonneg CHECK (accrued_30d >= 0)
);

CREATE INDEX IF NOT EXISTS player_bonus_accruals_accrued_idx
  ON player_bonus_accruals (accrued_30d DESC);

-- period=all ranks straight off players.bonus_balance (ECON-5 #165).
CREATE INDEX IF NOT EXISTS players_bonus_balance_desc_idx
  ON players (bonus_balance DESC);
