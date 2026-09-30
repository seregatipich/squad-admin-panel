-- combat_events (COMBAT-2): monthly RANGE-partitioned kill/damage/wound/revive feed.
--
-- Mirrors PRES-1 (packages/db/sql/player-sessions.sql) and CHATLOG-1
-- (packages/db/sql/chat-messages.sql): native declarative partitioning by
-- occurred_at plus bootstrap partitions and a DEFAULT catch-all.
-- worker-event-partition (`ensureDefaultBackedMonthlyPartitions`) keeps the
-- current and next month partitioned from then on, moving any rows already in
-- the DEFAULT partition, and drops nothing; pg_partman is not installed
-- anywhere. Drizzle-kit generates the plain table from
-- packages/db/src/schema/combat-events.ts; this file adds the partitioning, the
-- partial teamkill index, the BRIN index and the DESC index ordering that
-- Drizzle cannot express.
--
-- UUID-only: attacker/victim reference players(id); no steam_id64 columns.
--
-- The whole file is idempotent (IF NOT EXISTS everywhere) so it can be
-- re-applied without error.

-- DOSSIER-1: event_type gains 'vehicle_destroyed', victim_player_id is NULLABLE
-- (vehicle victims have no player), and victim_vehicle / attacker_vehicle carry
-- the raw Squad asset-IDs localized via vehicle_catalog.
CREATE TABLE IF NOT EXISTS combat_events (
  id                bigint      GENERATED ALWAYS AS IDENTITY,
  event_type        text        NOT NULL,
  server_id         uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  match_id          bigint,
  attacker_player_id uuid       REFERENCES players(id) ON DELETE SET NULL,
  victim_player_id  uuid        REFERENCES players(id) ON DELETE CASCADE,
  victim_vehicle    text,
  attacker_vehicle  text,
  weapon            text,
  damage            numeric,
  attacker_kit      text,
  is_teamkill       boolean     NOT NULL DEFAULT false,
  occurred_at       timestamptz NOT NULL,
  CONSTRAINT combat_events_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT combat_events_event_type_chk
    CHECK (event_type IN ('death','damage','wound','revive','vehicle_destroyed'))
) PARTITION BY RANGE (occurred_at);

-- Issue #50: matches.id is a uuid, so match_id (bigint, never written) cannot
-- reference it; match_uuid is the real link (migration 0131).
ALTER TABLE combat_events
  ADD COLUMN IF NOT EXISTS match_uuid uuid REFERENCES matches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS combat_events_match_uuid_occurred_idx
  ON combat_events (match_uuid, occurred_at DESC)
  WHERE match_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS combat_events_server_occurred_idx
  ON combat_events (server_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS combat_events_attacker_occurred_idx
  ON combat_events (attacker_player_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS combat_events_victim_occurred_idx
  ON combat_events (victim_player_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS combat_events_teamkill_victim_idx
  ON combat_events (victim_player_id, occurred_at DESC)
  WHERE is_teamkill;
CREATE INDEX IF NOT EXISTS combat_events_occurred_at_brin_idx
  ON combat_events USING brin (occurred_at) WITH (pages_per_range = 32);

-- DEFAULT catch-all partition so inserts outside the bootstrap window still land.
CREATE TABLE IF NOT EXISTS combat_events_default PARTITION OF combat_events DEFAULT;

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
    part_name  := 'combat_events_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF combat_events FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;
