-- COMBAT-2 (#128): partitioned combat_events store (uuid FKs, monthly RANGE partitions)
CREATE TABLE IF NOT EXISTS combat_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  event_type text NOT NULL,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  match_id bigint,
  attacker_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  victim_player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  weapon text,
  damage numeric,
  attacker_kit text,
  is_teamkill boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT combat_events_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT combat_events_event_type_chk CHECK (event_type IN ('death','damage','wound','revive'))
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_server_occurred_idx ON combat_events (server_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_attacker_occurred_idx ON combat_events (attacker_player_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_victim_occurred_idx ON combat_events (victim_player_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_teamkill_victim_idx ON combat_events (victim_player_id, occurred_at DESC) WHERE is_teamkill;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS combat_events_occurred_at_brin_idx ON combat_events USING brin (occurred_at) WITH (pages_per_range = 32);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS combat_events_default PARTITION OF combat_events DEFAULT;
--> statement-breakpoint
DO $$
DECLARE m int; cur_month date := date_trunc('month', now())::date; part_start date; part_end date; part_name text;
BEGIN
  FOR m IN -1..3 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end := part_start + interval '1 month';
    part_name := 'combat_events_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF combat_events FOR VALUES FROM (%L) TO (%L)', part_name, part_start, part_end);
  END LOOP;
END$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_actor_occurred_idx ON events (actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_notes_created_at_idx ON player_notes (created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_notes_author_id_idx ON player_notes (author_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_notes_body_trgm_idx ON player_notes USING gin (body gin_trgm_ops);
