-- DOSSIER-4 (#191): monthly K/D trend + winrate source. The combat columns
-- (kills, deaths, teamkills, revives, kd_ratio) already exist on
-- player_stat_periods; they are now filled by the leaderboard recompute from
-- match_players ⋈ matches (no new table, no materialized view — the issue's
-- maintainer spec supersedes the original player_monthly_combat design).
-- This migration only adds the per-player lookup index that the
-- /combat-summary kd_trend query scans (player_id, period_type,
-- period_start DESC). match_players already carries
-- match_players_player_match_idx for the aggregation side.
-- See packages/db/src/schema/player-stat-periods.ts and
-- packages/db/src/leaderboard/aggregate.ts.

CREATE INDEX IF NOT EXISTS player_stat_periods_player_idx
  ON player_stat_periods (player_id, period_type, period_start DESC);
