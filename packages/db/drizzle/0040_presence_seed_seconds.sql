-- ECON-2 (#162): seed_seconds on player_daily_presence — seconds a player was
-- connected while the server population was below economy_settings.seed_threshold.
-- Populated by the economy accrual job in worker-presence-daily; consumed by the
-- earn_seed bonus accrual. Additive + idempotent.
ALTER TABLE player_daily_presence
  ADD COLUMN IF NOT EXISTS seed_seconds integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE player_daily_presence
  DROP CONSTRAINT IF EXISTS player_daily_presence_seconds_chk;
--> statement-breakpoint
ALTER TABLE player_daily_presence
  ADD CONSTRAINT player_daily_presence_seconds_chk
    CHECK (online_seconds >= 0 AND boost_seconds >= 0
      AND queue_seconds >= 0 AND seed_seconds >= 0 AND session_count >= 0);
