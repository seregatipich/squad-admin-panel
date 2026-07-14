ALTER TABLE external_ban_sources
  ADD COLUMN IF NOT EXISTS parser_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE external_ban_sources
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
