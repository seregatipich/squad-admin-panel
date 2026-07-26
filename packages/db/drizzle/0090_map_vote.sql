-- GAME-1 (#80): panel-driven map auto-selection ("map vote" reframed per the
-- 2026-07-09 map-rotation ADR). `map_vote_candidates` is the per-server pool
-- of layers the scheduler tick may pick from; `map_vote_picks` records exactly
-- one decision per match (unique match_id = the tick's idempotency guard).
-- server_settings gains the per-server enable/rule/cooldown configuration.
-- See packages/db/src/schema/map-vote.ts and server-settings.ts.

CREATE TABLE IF NOT EXISTS map_vote_candidates (
  id         uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id  uuid         NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  layer      text         NOT NULL,
  weight     integer      NOT NULL DEFAULT 1,
  enabled    boolean      NOT NULL DEFAULT true,
  created_by uuid         REFERENCES players(id) ON DELETE SET NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT map_vote_candidates_weight_check CHECK (weight >= 1 AND weight <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS map_vote_candidates_server_layer_key
  ON map_vote_candidates (server_id, layer);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS map_vote_candidates_server_enabled_idx
  ON map_vote_candidates (server_id) WHERE enabled;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS map_vote_picks (
  id                 uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id          uuid         NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  match_id           uuid         NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  layer              text         NOT NULL,
  selection          text         NOT NULL,
  candidate_snapshot jsonb        NOT NULL DEFAULT '[]'::jsonb,
  rng_seed           text,
  applied            boolean      NOT NULL DEFAULT false,
  failure_reason     text,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT map_vote_picks_selection_check
    CHECK (selection IN ('weighted_random','least_recently_played'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS map_vote_picks_match_key
  ON map_vote_picks (match_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS map_vote_picks_server_created_idx
  ON map_vote_picks (server_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS map_vote_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS map_vote_selection text NOT NULL DEFAULT 'weighted_random';
--> statement-breakpoint
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS map_vote_layer_cooldown integer NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS map_vote_map_cooldown integer NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS map_vote_broadcast_template text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'server_settings_map_vote_selection_check'
      AND conrelid = 'server_settings'::regclass
  ) THEN
    ALTER TABLE server_settings
      ADD CONSTRAINT server_settings_map_vote_selection_check
      CHECK (map_vote_selection IN ('weighted_random','least_recently_played'));
  END IF;
END $$;
--> statement-breakpoint
