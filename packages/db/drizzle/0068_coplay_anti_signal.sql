-- ALT-3: co-play overlap as a negative-weight anti-signal on the ALT-1 score.
-- A pair that regularly plays *simultaneously* on the same server looks more
-- like friends than one person's alt/twink pair, so a large rolling-window
-- `player_coplay.overlap_seconds` subtracts from the ALT-1 candidate score.
-- Hand-authored (additive, fully idempotent) — no new tables; `player_coplay`
-- and `coplay_settings` already exist (0036_player_coplay.sql).

ALTER TABLE alt_detection_settings
  ADD COLUMN IF NOT EXISTS weight_coplay_overlap integer NOT NULL DEFAULT 30;
ALTER TABLE alt_detection_settings
  ADD COLUMN IF NOT EXISTS coplay_overlap_threshold_seconds integer NOT NULL DEFAULT 36000;
