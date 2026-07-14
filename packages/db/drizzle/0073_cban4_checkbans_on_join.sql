-- CBAN-4: configure the action taken when an active external ban matches a
-- player.connected event. Trust-level enforcement is validated by the API;
-- the worker also fails closed and never kicks an untrusted source.
ALTER TABLE external_ban_sources
  ADD COLUMN IF NOT EXISTS on_match text NOT NULL DEFAULT 'alert';

DO $$
BEGIN
  ALTER TABLE external_ban_sources
    ADD CONSTRAINT external_ban_sources_on_match_chk
    CHECK (on_match IN ('none', 'alert', 'kick'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
