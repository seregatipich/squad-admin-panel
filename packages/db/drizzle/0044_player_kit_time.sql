-- DOSSIER-3 (#190): per-kit, per-server accrued playtime.
-- Accumulated by worker-rcon from periodic ListPlayers polling: each poll
-- interval a player spends holding a given kit accrues its elapsed seconds
-- here. `kit` is the faction-stripped, normalized role name produced by
-- normalizeRoleName (@squad/shared-config) — never the raw per-faction
-- Squad role-string. Independent, time-based counterpart to the RNSquadJS
-- kit-usage counts (STATS-4); feeds the player-profile "Kits" tab
-- (DOSSIER-6). Retention is indefinite.
CREATE TABLE IF NOT EXISTS player_kit_time (
  player_id      uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kit            text NOT NULL,
  server_id      uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  seconds        bigint NOT NULL DEFAULT 0,
  last_played_at timestamptz,
  CONSTRAINT player_kit_time_pk PRIMARY KEY (player_id, kit, server_id),
  CONSTRAINT player_kit_time_seconds_chk CHECK (seconds >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_kit_time_player_id_idx
  ON player_kit_time (player_id);
