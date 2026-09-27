-- player_sessions (PRES-1): monthly RANGE-partitioned presence sessions.
--
-- Mirrors the events table strategy from 0000_init.sql: native declarative
-- partitioning by connected_at plus bootstrap partitions. worker-event-partition
-- (`ensurePlayerSessionPartitions`) keeps the current and next month
-- partitioned from then on and drops nothing; pg_partman is not installed
-- anywhere. Drizzle-kit generates the plain table from
-- packages/db/src/schema/player-sessions.ts; this file adds the partitioning,
-- the BRIN index and the DESC index ordering that Drizzle cannot express.
--
-- The whole file is idempotent (IF NOT EXISTS everywhere) so it can be
-- re-applied without error.

CREATE TABLE IF NOT EXISTS player_sessions (
  id               bigserial   NOT NULL,
  player_id        uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id        uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  connected_at     timestamptz NOT NULL,
  disconnected_at  timestamptz,
  duration_seconds integer,
  closed_reason    text,
  mode             text        NOT NULL DEFAULT 'online',
  CONSTRAINT player_sessions_pkey PRIMARY KEY (id, connected_at),
  CONSTRAINT player_sessions_closed_reason_chk
    CHECK (closed_reason IS NULL
      OR closed_reason IN ('disconnect','server_crashed','kicked','banned')),
  CONSTRAINT player_sessions_mode_chk
    CHECK (mode IN ('online','boost','queue','seed'))
) PARTITION BY RANGE (connected_at);

ALTER TABLE player_sessions DROP CONSTRAINT IF EXISTS player_sessions_mode_chk;
ALTER TABLE player_sessions
  ADD CONSTRAINT player_sessions_mode_chk
  CHECK (mode IN ('online','boost','queue','seed'));

CREATE INDEX IF NOT EXISTS player_sessions_player_connected_idx
  ON player_sessions (player_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_server_connected_idx
  ON player_sessions (server_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_open_idx
  ON player_sessions (server_id, player_id)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS player_sessions_connected_at_brin_idx
  ON player_sessions USING brin (connected_at) WITH (pages_per_range = 32);

-- Bootstrap partitions: previous month + current + 3 look-ahead months.
-- worker-event-partition creates the following months.
DO $$
DECLARE
  m          int;
  cur_month  date := date_trunc('month', now())::date;
  part_start date;
  part_end   date;
  part_name  text;
BEGIN
  FOR m IN -1..3 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end   := part_start + interval '1 month';
    part_name  := 'player_sessions_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF player_sessions FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;
