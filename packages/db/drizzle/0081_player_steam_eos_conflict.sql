-- PLAYER-1 (#22): flag a player whose EOS identity has been observed paired
-- with more than one SteamID64. The connection-handling algorithm (§1.1.2) sets
-- this when a known eos_id connects with a different steam_id64 than stored, so
-- moderators can review the mismatched identity. Defaults false for every
-- existing row; no backfill needed.
ALTER TABLE players ADD COLUMN IF NOT EXISTS steam_eos_conflict boolean NOT NULL DEFAULT false;
