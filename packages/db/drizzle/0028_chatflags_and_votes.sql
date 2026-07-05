-- Batch 8: CHATLOG-5 (chat_flag_rules + chat_messages.matched_rule_id) + VOTE-1 (game_votes/ballots).

CREATE TABLE IF NOT EXISTS chat_flag_rules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern      text        NOT NULL,
  pattern_type text        NOT NULL DEFAULT 'word',
  locale       text        NOT NULL DEFAULT 'all',
  enabled      boolean     NOT NULL DEFAULT true,
  created_by   uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_flag_rules_pattern_type_chk CHECK (pattern_type IN ('word','regex'))
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_flag_rules_pattern_key ON chat_flag_rules (pattern, pattern_type, locale);
CREATE INDEX IF NOT EXISTS chat_flag_rules_enabled_idx ON chat_flag_rules (enabled, created_at);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS matched_rule_id uuid REFERENCES chat_flag_rules(id) ON DELETE SET NULL;
INSERT INTO chat_flag_rules (pattern, pattern_type, locale) VALUES
  ('блять','word','ru'),('сука','word','ru'),('хуй','word','ru'),('пизда','word','ru'),
  ('ебать','word','ru'),('мудак','word','ru'),('гандон','word','ru'),
  ('fuck','word','en'),('shit','word','en'),('bitch','word','en'),('asshole','word','en'),('cunt','word','en')
ON CONFLICT (pattern, pattern_type, locale) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  initiator_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  vote_type text NOT NULL,
  map_current text, map_next text, map_target text,
  votes_collected integer DEFAULT 0 NOT NULL,
  votes_required integer DEFAULT 0 NOT NULL,
  result text, duration_seconds integer,
  started_at timestamptz NOT NULL, ended_at timestamptz,
  CONSTRAINT game_votes_vote_type_enum CHECK (vote_type IN ('map_skip','map_change','admin')),
  CONSTRAINT game_votes_result_enum CHECK (result IN ('passed','failed','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS game_votes_server_started_key ON game_votes (server_id, started_at);
CREATE INDEX IF NOT EXISTS game_votes_server_started_idx ON game_votes (server_id, started_at DESC);
CREATE INDEX IF NOT EXISTS game_votes_started_idx ON game_votes (started_at DESC);
CREATE INDEX IF NOT EXISTS game_votes_initiator_idx ON game_votes (initiator_player_id) WHERE initiator_player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS game_votes_type_idx ON game_votes (vote_type);

CREATE TABLE IF NOT EXISTS game_vote_ballots (
  vote_id uuid NOT NULL REFERENCES game_votes(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  choice text NOT NULL, voted_at timestamptz NOT NULL,
  CONSTRAINT game_vote_ballots_pkey PRIMARY KEY (vote_id, player_id),
  CONSTRAINT game_vote_ballots_choice_enum CHECK (choice IN ('yes','no'))
);
CREATE INDEX IF NOT EXISTS game_vote_ballots_player_idx ON game_vote_ballots (player_id);
