-- Issue #52: the public whitelist portal takes steam_id64 from the request
-- body, and one pending application per SteamID64 was allowed — so anyone
-- could file for a foreign SteamID and lock its owner out (409) until a
-- moderator rejected the squatter. An application submitted from a Steam login
-- for that same SteamID is now `verified`, and uniqueness is kept per
-- verification state: an anonymous application can no longer block a verified
-- one, while each kind still admits one pending row per SteamID.
ALTER TABLE whitelist_applications
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS whitelist_applications_pending_verified_steam_unique_idx
  ON whitelist_applications (steam_id64)
  WHERE status = 'pending' AND verified;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS whitelist_applications_pending_unverified_steam_unique_idx
  ON whitelist_applications (steam_id64)
  WHERE status = 'pending' AND NOT verified;
--> statement-breakpoint
DROP INDEX IF EXISTS whitelist_applications_pending_steam_unique_idx;
--
-- Rollback-safe: the previous release never names `verified` (its inserts get
-- the default false) and still maps a unique violation on a second anonymous
-- pending application to 409 through the unverified index.
