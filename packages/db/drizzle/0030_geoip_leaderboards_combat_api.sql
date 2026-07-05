-- PLAYER-3 (#24): frozen GeoIP columns on player_ip_history + MaxMind settings singleton
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS country_name text;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS timezone_offset text;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE player_ip_history ADD COLUMN IF NOT EXISTS longitude double precision;
CREATE TABLE IF NOT EXISTS geoip_settings (
  id uuid PRIMARY KEY NOT NULL,
  account_id text,
  license_key_encrypted bytea,
  db_path text,
  last_refreshed_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  key_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- COMBAT-3 (#129): combat:view panel permission on roles (default for panel_access + Owner)
ALTER TABLE roles ADD COLUMN IF NOT EXISTS combat_view boolean NOT NULL DEFAULT true;
UPDATE roles SET combat_view = true WHERE panel_access = true;
UPDATE roles SET combat_view = true WHERE name = 'Owner' AND is_system_role = true;

-- LEAD-1 (#172): materialized leaderboard aggregates
CREATE TABLE IF NOT EXISTS player_stat_periods (
  player_id       uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id       uuid             REFERENCES servers(id) ON DELETE CASCADE,
  period_type     text    NOT NULL,
  period_start    date    NOT NULL,
  online_seconds  integer NOT NULL DEFAULT 0,
  seeding_seconds integer NOT NULL DEFAULT 0,
  kills           integer NOT NULL DEFAULT 0,
  deaths          integer NOT NULL DEFAULT 0,
  teamkills       integer NOT NULL DEFAULT 0,
  revives         integer NOT NULL DEFAULT 0,
  kd_ratio        numeric NOT NULL DEFAULT 0,
  matches_played  integer NOT NULL DEFAULT 0,
  CONSTRAINT player_stat_periods_identity
    UNIQUE NULLS NOT DISTINCT (player_id, server_id, period_type, period_start),
  CONSTRAINT player_stat_periods_period_type_chk
    CHECK (period_type IN ('day','week','month','season','alltime')),
  CONSTRAINT player_stat_periods_metrics_chk
    CHECK (online_seconds >= 0 AND seeding_seconds >= 0 AND kills >= 0
      AND deaths >= 0 AND teamkills >= 0 AND revives >= 0
      AND matches_played >= 0 AND kd_ratio >= 0)
);
CREATE INDEX IF NOT EXISTS player_stat_periods_online_idx ON player_stat_periods (period_type, period_start, server_id, online_seconds DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_seeding_idx ON player_stat_periods (period_type, period_start, server_id, seeding_seconds DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_kills_idx ON player_stat_periods (period_type, period_start, server_id, kills DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_deaths_idx ON player_stat_periods (period_type, period_start, server_id, deaths DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_teamkills_idx ON player_stat_periods (period_type, period_start, server_id, teamkills DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_revives_idx ON player_stat_periods (period_type, period_start, server_id, revives DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_kd_idx ON player_stat_periods (period_type, period_start, server_id, kd_ratio DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_matches_idx ON player_stat_periods (period_type, period_start, server_id, matches_played DESC);

-- MATCH-3 (#135): per-match player combat columns (NULL = no data)
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS kills integer;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS deaths integer;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS teamkills integer;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS wounds integer;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS revives integer;
ALTER TABLE match_players ADD CONSTRAINT match_players_combat_chk CHECK ((kills IS NULL OR kills >= 0) AND (deaths IS NULL OR deaths >= 0) AND (teamkills IS NULL OR teamkills >= 0) AND (wounds IS NULL OR wounds >= 0) AND (revives IS NULL OR revives >= 0));
