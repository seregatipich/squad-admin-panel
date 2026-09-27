-- chat_messages (CHATLOG-1): monthly RANGE-partitioned in-game + panel chat log.
--
-- Mirrors PRES-1 (packages/db/sql/player-sessions.sql): native declarative
-- partitioning by sent_at plus bootstrap partitions and a DEFAULT catch-all
-- (migration 0117). worker-event-partition (`ensureDefaultBackedMonthlyPartitions`)
-- keeps the current and next month partitioned from then on and drops nothing;
-- pg_partman is not installed anywhere. Drizzle-kit generates the plain table from
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

-- DEFAULT catch-all partition so a row outside every monthly partition is
-- stored instead of rejected (migration 0117).
CREATE TABLE IF NOT EXISTS chat_messages_default PARTITION OF chat_messages DEFAULT;

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
    part_name  := 'chat_messages_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;
