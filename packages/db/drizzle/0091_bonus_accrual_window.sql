-- ECON-5 (#165): bonus leaderboard. `player_bonus_accruals` holds the
-- precomputed rolling 30-day bonus accrual window per player — a plain
-- aggregate table fully rebuilt by the leaderboard-aggregator tick
-- (recomputeBonusAccruals), replacing the issue's "materialized view
-- refreshed hourly" with the house pattern. `players_bonus_balance_desc_idx`
-- serves the period=all ranking straight off players.bonus_balance.
-- See packages/db/src/schema/player-bonus-accruals.ts.

CREATE TABLE IF NOT EXISTS player_bonus_accruals (
  player_id   uuid        PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  accrued_30d integer     NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_bonus_accruals_nonneg CHECK (accrued_30d >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_bonus_accruals_accrued_idx
  ON player_bonus_accruals (accrued_30d DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_bonus_balance_desc_idx
  ON players (bonus_balance DESC);
--> statement-breakpoint
