-- Batch 5: PRES-2 (player_daily_presence), MATCH-2 (match_players),
-- CHATLOG-1 (chat_messages, partitioned). Hand-authored (partitioning/trgm/BRIN).

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
CREATE INDEX IF NOT EXISTS player_daily_presence_day_idx ON player_daily_presence (day);

CREATE TABLE IF NOT EXISTS match_players (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team smallint,
  squad_name text,
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  play_seconds integer NOT NULL,
  CONSTRAINT match_players_match_id_player_id_pk PRIMARY KEY (match_id, player_id),
  CONSTRAINT match_players_team_chk CHECK (team IS NULL OR team IN (1, 2)),
  CONSTRAINT match_players_play_seconds_chk CHECK (play_seconds >= 0)
);
CREATE INDEX IF NOT EXISTS match_players_player_match_idx ON match_players (player_id, match_id);

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
  CONSTRAINT chat_messages_scope_chk CHECK (scope IN ('all','team','squad','admin','broadcast','direct')),
  CONSTRAINT chat_messages_source_chk CHECK (source IN ('log','panel'))
) PARTITION BY RANGE (sent_at);
CREATE INDEX IF NOT EXISTS chat_messages_player_sent_idx ON chat_messages (player_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_server_sent_idx ON chat_messages (server_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_message_trgm_idx ON chat_messages USING gin (message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS chat_messages_sent_at_brin_idx ON chat_messages USING brin (sent_at) WITH (pages_per_range = 32);
DO $$
DECLARE m int; cur_month date := date_trunc('month', now())::date; part_start date; part_end date; part_name text;
BEGIN
  FOR m IN -1..3 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end := part_start + interval '1 month';
    part_name := 'chat_messages_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)', part_name, part_start, part_end);
  END LOOP;
END$$;
