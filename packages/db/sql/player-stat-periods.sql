-- player_stat_periods (LEAD-1): materialised leaderboard aggregates per
-- (player, server, period_type, period_start). server_id NULL is the
-- all-servers rollup, so the identity uniqueness uses NULLS NOT DISTINCT
-- (Postgres 15+) rather than a classic primary key, which cannot span a
-- nullable column. Plain table (not partitioned): the per-metric composite
-- indexes satisfy the <100ms top-100 criterion. This file mirrors
-- packages/db/src/schema/player-stat-periods.ts and is fully idempotent so it
-- can be re-applied by the integration tests and the orchestrator.

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

CREATE INDEX IF NOT EXISTS player_stat_periods_online_idx
  ON player_stat_periods (period_type, period_start, server_id, online_seconds DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_seeding_idx
  ON player_stat_periods (period_type, period_start, server_id, seeding_seconds DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_kills_idx
  ON player_stat_periods (period_type, period_start, server_id, kills DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_deaths_idx
  ON player_stat_periods (period_type, period_start, server_id, deaths DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_teamkills_idx
  ON player_stat_periods (period_type, period_start, server_id, teamkills DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_revives_idx
  ON player_stat_periods (period_type, period_start, server_id, revives DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_kd_idx
  ON player_stat_periods (period_type, period_start, server_id, kd_ratio DESC);
CREATE INDEX IF NOT EXISTS player_stat_periods_matches_idx
  ON player_stat_periods (period_type, period_start, server_id, matches_played DESC);
