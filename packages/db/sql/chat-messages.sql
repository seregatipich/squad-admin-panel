-- chat_messages (CHATLOG-1): monthly RANGE-partitioned in-game + panel chat log.
--
-- Mirrors PRES-1 (packages/db/sql/player-sessions.sql): native declarative
-- partitioning by sent_at plus bootstrap partitions. In production
-- pg_partman.create_parent takes over rotation with 12-month retention (see the
-- pg_partman block at the bottom, kept commented because the extension is not
-- installed in CI). Drizzle-kit generates the plain table from
-- packages/db/src/schema/chat-messages.ts; this file adds the partitioning, the
-- GIN pg_trgm index, the BRIN index and the DESC index ordering that Drizzle
-- cannot express.
--
-- The whole file is idempotent (IF NOT EXISTS everywhere) so it can be
-- re-applied without error.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS chat_messages (
  id         bigserial   NOT NULL,
  player_id  uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id  uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL,
  scope      text        NOT NULL,
  team_id    smallint,
  squad_id   integer,
  message    text        NOT NULL,
  source     text        NOT NULL DEFAULT 'log',
  is_flagged boolean     NOT NULL DEFAULT false,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id, sent_at),
  CONSTRAINT chat_messages_scope_chk
    CHECK (scope IN ('all','team','squad','admin','broadcast','direct')),
  CONSTRAINT chat_messages_source_chk
    CHECK (source IN ('log','panel'))
) PARTITION BY RANGE (sent_at);

CREATE INDEX IF NOT EXISTS chat_messages_player_sent_idx
  ON chat_messages (player_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_server_sent_idx
  ON chat_messages (server_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_message_trgm_idx
  ON chat_messages USING gin (message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS chat_messages_sent_at_brin_idx
  ON chat_messages USING brin (sent_at) WITH (pages_per_range = 32);

-- Bootstrap partitions: previous month + current + 3 look-ahead months.
-- pg_partman / pg_cron create and drop the rest in production.
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
    part_name  := 'chat_messages_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- Production rotation (pg_partman). Not run in CI because pg_partman is not
-- installed on the CI Postgres image; the orchestrator enables it in the
-- production migration:
--
--   CREATE EXTENSION IF NOT EXISTS pg_partman;
--   SELECT partman.create_parent(
--     p_parent_table    => 'public.chat_messages',
--     p_control         => 'sent_at',
--     p_type            => 'range',
--     p_interval        => '1 month',
--     p_premake         => 3
--   );
--   UPDATE partman.part_config
--   SET retention             = '12 months',
--       retention_keep_table  = false,
--       infinite_time_partitions = true
--   WHERE parent_table = 'public.chat_messages';
--
-- pg_cron then runs SELECT partman.run_maintenance() hourly, or the existing
-- event-partition worker rotates partitions the same way it does for events.
-- ---------------------------------------------------------------------------
