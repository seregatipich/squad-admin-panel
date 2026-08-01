-- Wave 5/7 batch 4: PRES-1 (player_sessions, partitioned) + MATCH-1 (matches).
-- Hand-authored (partitioning/BRIN/DESC indexes are not drizzle-expressible).

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
    CHECK (mode IN ('online','boost','queue'))
) PARTITION BY RANGE (connected_at);

CREATE INDEX IF NOT EXISTS player_sessions_player_connected_idx
  ON player_sessions (player_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_server_connected_idx
  ON player_sessions (server_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_open_idx
  ON player_sessions (server_id, player_id)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS player_sessions_connected_at_brin_idx
  ON player_sessions USING brin (connected_at) WITH (pages_per_range = 32);

-- Bootstrap partitions: 6 look-back months through 3 look-ahead months.
-- pg_partman / pg_cron create and drop the rest in production. The
-- look-back margin exists so fixture data in tests migrated well after this
-- file was authored still lands in a partition that exists (this migration
-- only ever runs once, against a freshly created database, so widening it
-- here never touches an already-migrated database).
DO $$
DECLARE
  m          int;
  cur_month  date := date_trunc('month', now())::date;
  part_start date;
  part_end   date;
  part_name  text;
BEGIN
  FOR m IN -6..3 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end   := part_start + interval '1 month';
    part_name  := 'player_sessions_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF player_sessions FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;

-- ===== matches (MATCH-1) =====
CREATE TABLE IF NOT EXISTS matches (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	server_id uuid NOT NULL,
	layer text,
	map text,
	game_mode text,
	team1_faction text,
	team2_faction text,
	team1_tickets integer,
	team2_tickets integer,
	winner text,
	is_seed boolean DEFAULT false NOT NULL,
	started_at timestamp with time zone NOT NULL,
	ended_at timestamp with time zone,
	duration_seconds integer,
	end_reason text,
	CONSTRAINT matches_winner_enum CHECK (winner IN ('team1','team2','draw')),
	CONSTRAINT matches_end_reason_enum CHECK (end_reason IN ('ended','server_crashed','server_restarted'))
);
ALTER TABLE matches ADD CONSTRAINT matches_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX matches_server_started_key ON matches USING btree (server_id, started_at);
CREATE INDEX matches_server_started_idx ON matches USING btree (server_id, started_at DESC);
CREATE INDEX matches_started_idx ON matches USING btree (started_at DESC);
CREATE INDEX matches_layer_idx ON matches USING btree (layer);
CREATE INDEX matches_open_idx ON matches USING btree (server_id, started_at DESC) WHERE ended_at IS NULL;
