-- INT-1 (#76): persist the Steam Web API snapshot for a player.
--
-- Until now the Steam profile was fetched live at login and only cached in
-- Redis (`steam-profile:<id>`, 1 h), so nothing survived a cache eviction and
-- the player card had no avatar, no VAC state and no game-ownership signal.
-- These columns are the durable copy, refreshed on demand via
-- POST /api/v1/players/:playerId/steam-refresh.
--
-- Nullability encodes provenance, not just absence:
--   * `owns_squad` / `steam_playtime_minutes` are NULL when Steam did not
--     disclose the game list (private profile) — "unknown", not "does not own".
--   * `profile_visibility` mirrors GetPlayerSummaries.communityvisibilitystate
--     (1 = private, 3 = public); NULL when Steam omitted it.
--   * `steam_account_created_at` is GetPlayerSummaries.timecreated, which Steam
--     only returns for public profiles.
-- The ban counters are NOT NULL with a zero default so "clean" is representable
-- without a NULL check on every read; `days_since_last_ban` stays nullable
-- because Steam reports 0 both for "banned today" and "never banned", and the
-- refresh route stores NULL when there is no ban at all.
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_url text;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS persona_name text;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_visibility smallint;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS steam_account_created_at timestamptz;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS vac_banned boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS vac_ban_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS game_ban_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS days_since_last_ban integer;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS owns_squad boolean;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS steam_playtime_minutes integer;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS steam_checked_at timestamptz;
--> statement-breakpoint
-- Serves "which Steam-linked players are due for a refresh": never-checked rows
-- sort first, then the stalest. Partial on steam_id64 because a player without
-- a SteamID64 can never be refreshed.
CREATE INDEX IF NOT EXISTS players_steam_checked_at_idx
  ON players (steam_checked_at NULLS FIRST) WHERE steam_id64 IS NOT NULL;
