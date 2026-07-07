-- DOSSIER-2 (#189): per-weapon and per-vehicle dossier aggregates.
-- Three incremental aggregate tables keyed on players.id (uuid), not steam_id64,
-- so EOS-only players aggregate correctly. `damage` is NULLABLE everywhere: when
-- the source log line carries no damage magnitude the aggregate accumulates only
-- counters and the UI renders "—". These tables have INDEFINITE retention — they
-- outlive the 24-month combat_events partition drops (the "multi-year history").
CREATE TABLE IF NOT EXISTS player_weapon_stats (
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  weapon        text NOT NULL,
  kills         integer NOT NULL DEFAULT 0,
  teamkills     integer NOT NULL DEFAULT 0,
  damage        numeric,
  shots_events  integer NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  CONSTRAINT player_weapon_stats_pk PRIMARY KEY (player_id, weapon),
  CONSTRAINT player_weapon_stats_counts_chk
    CHECK (kills >= 0 AND teamkills >= 0 AND shots_events >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_weapon_stats_kills_idx
  ON player_weapon_stats (player_id, kills DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS player_vehicle_stats (
  player_id         uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  vehicle_asset_id  text NOT NULL,
  kills             integer NOT NULL DEFAULT 0,
  damage            numeric,
  CONSTRAINT player_vehicle_stats_pk PRIMARY KEY (player_id, vehicle_asset_id),
  CONSTRAINT player_vehicle_stats_counts_chk CHECK (kills >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_vehicle_stats_kills_idx
  ON player_vehicle_stats (player_id, kills DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS player_vehicle_kills (
  player_id                uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  victim_vehicle_asset_id  text NOT NULL,
  weapon                   text NOT NULL,
  destroyed_count          integer NOT NULL DEFAULT 0,
  CONSTRAINT player_vehicle_kills_pk PRIMARY KEY (player_id, victim_vehicle_asset_id, weapon),
  CONSTRAINT player_vehicle_kills_counts_chk CHECK (destroyed_count >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_vehicle_kills_count_idx
  ON player_vehicle_kills (player_id, destroyed_count DESC);
