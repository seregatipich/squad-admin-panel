-- combat_events (COMBAT-2): monthly RANGE-partitioned kill/damage/wound/revive feed.
--
-- Mirrors PRES-1 (packages/db/sql/player-sessions.sql) and CHATLOG-1
-- (packages/db/sql/chat-messages.sql): native declarative partitioning by
-- occurred_at plus bootstrap partitions and a DEFAULT catch-all. In production
-- pg_partman.create_parent takes over rotation with 12-month retention (see the
-- pg_partman block at the bottom, kept commented because the extension is not
-- installed in CI). Drizzle-kit generates the plain table from
-- packages/db/src/schema/combat-events.ts; this file adds the partitioning, the
-- partial teamkill index, the BRIN index and the DESC index ordering that
-- Drizzle cannot express.
--
-- UUID-only: attacker/victim reference players(id); no steam_id64 columns.
--
-- The whole file is idempotent (IF NOT EXISTS everywhere) so it can be
-- re-applied without error.

CREATE TABLE IF NOT EXISTS combat_events (
  id                bigint      GENERATED ALWAYS AS IDENTITY,
  event_type        text        NOT NULL,
  server_id         uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  match_id          bigint,
  attacker_player_id uuid       REFERENCES players(id) ON DELETE SET NULL,
  victim_player_id  uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  weapon            text,
  damage            numeric,
  attacker_kit      text,
  is_teamkill       boolean     NOT NULL DEFAULT false,
  occurred_at       timestamptz NOT NULL,
  CONSTRAINT combat_events_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT combat_events_event_type_chk
    CHECK (event_type IN ('death','damage','wound','revive'))
) PARTITION BY RANGE (occurred_at);

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
    part_name  := 'combat_events_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF combat_events FOR VALUES FROM (%L) TO (%L)',
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
--     p_parent_table    => 'public.combat_events',
--     p_control         => 'occurred_at',
--     p_type            => 'range',
--     p_interval        => '1 month',
--     p_premake         => 3
--   );
--   UPDATE partman.part_config
--   SET retention             = '12 months',
--       retention_keep_table  = false,
--       infinite_time_partitions = true
--   WHERE parent_table = 'public.combat_events';
--
-- pg_cron then runs SELECT partman.run_maintenance() hourly, or the existing
-- event-partition worker rotates partitions the same way it does for events.
-- ---------------------------------------------------------------------------
