-- Issue #6: `chat_messages` (0025) and `bonus_transactions` (0026) only ever had
-- the monthly partitions their migrations created — the pg_partman rotation
-- their SQL files assumed was never installed — and no DEFAULT partition, so
-- every chat, bonus-ledger and VIP-grant insert starts failing with
-- `no partition of relation … found for row` the first day past that window
-- (2026-11-01 on production). `combat_events` (0029) has a DEFAULT partition
-- but was not rotated either, so its rows would pile up there.
--
-- worker-event-partition now keeps the current + next month of all three
-- tables. This migration removes the risk on its own, before the worker runs:
--   1. DEFAULT partitions for `chat_messages` and `bonus_transactions`, so a row
--      outside every monthly partition is stored instead of rejected;
--   2. the current UTC month and three months ahead for all three tables.
-- Postgres refuses to add a partition whose range the DEFAULT partition still
-- holds rows for, so each missing month is built as a plain table, receives the
-- DEFAULT partition's rows for its range and is then attached. The same steps
-- run in the worker (`ensureDefaultBackedMonthlyPartitions`).
--
-- Rollback-safe: the previous release neither creates nor drops partitions of
-- these tables, and a DEFAULT partition is invisible to its queries.
CREATE TABLE IF NOT EXISTS chat_messages_default PARTITION OF chat_messages DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bonus_transactions_default PARTITION OF bonus_transactions DEFAULT;
--> statement-breakpoint
DO $$
DECLARE
  t          record;
  m          int;
  cur_month  date := date_trunc('month', timezone('UTC', now()))::date;
  part_start date;
  part_end   date;
  part_name  text;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('chat_messages', 'sent_at'),
      ('bonus_transactions', 'created_at'),
      ('combat_events', 'occurred_at')
    ) AS v(parent, key_column)
  LOOP
    FOR m IN 0..3 LOOP
      part_start := (cur_month + make_interval(months => m))::date;
      part_end   := (part_start + interval '1 month')::date;
      part_name  := t.parent || '_' || to_char(part_start, 'YYYY_MM');
      CONTINUE WHEN to_regclass(part_name) IS NOT NULL;

      EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', t.parent || '_default');
      EXECUTE format(
        'CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
        part_name, t.parent
      );
      EXECUTE format(
        'WITH moved AS (DELETE FROM %I WHERE %I >= %L AND %I < %L RETURNING *) '
          || 'INSERT INTO %I SELECT * FROM moved',
        t.parent || '_default', t.key_column, part_start, t.key_column, part_end, part_name
      );
      EXECUTE format(
        'ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
        t.parent, part_name, part_start, part_end
      );
    END LOOP;
  END LOOP;
END$$;
