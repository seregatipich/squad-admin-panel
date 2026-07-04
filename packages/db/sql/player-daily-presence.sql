-- player_daily_presence (PRES-2): per (player, day, server) presence rollups
-- derived idempotently from player_sessions (PRES-1). Unlike player_sessions
-- this table is small (one row per player/day/server) and is NOT partitioned;
-- drizzle-kit can express every column and index from
-- packages/db/src/schema/player-daily-presence.ts. This file exists so the
-- integration tests and the orchestrator can materialise the table without the
-- throwaway drizzle migration, mirroring packages/db/sql/player-sessions.sql.
--
-- The whole file is idempotent (IF NOT EXISTS everywhere) so it can be
-- re-applied without error.

CREATE TABLE IF NOT EXISTS player_daily_presence (
  player_id      uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day            date    NOT NULL,
  server_id      uuid    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  online_seconds integer NOT NULL DEFAULT 0,
  boost_seconds  integer NOT NULL DEFAULT 0,
  queue_seconds  integer NOT NULL DEFAULT 0,
  session_count  integer NOT NULL DEFAULT 0,
  CONSTRAINT player_daily_presence_pkey PRIMARY KEY (player_id, day, server_id),
  CONSTRAINT player_daily_presence_seconds_chk
    CHECK (online_seconds >= 0 AND boost_seconds >= 0
      AND queue_seconds >= 0 AND session_count >= 0)
);

CREATE INDEX IF NOT EXISTS player_daily_presence_day_idx
  ON player_daily_presence (day);
