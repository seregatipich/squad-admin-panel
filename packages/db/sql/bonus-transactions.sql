-- bonus_transactions (ECON-1): monthly RANGE-partitioned append-only bonus
-- ledger, plus the denormalized players.bonus_balance counter.
--
-- Mirrors the player_sessions strategy (PRES-1): native declarative
-- partitioning by created_at plus bootstrap partitions. In production
-- pg_partman.create_parent takes over rotation with 24-month retention (see the
-- pg_partman block at the bottom, kept commented because the extension is not
-- installed in CI). Drizzle-kit generates the plain table from
-- packages/db/src/schema/bonus-transactions.ts; this file adds the
-- partitioning, the partition-key-aware unique index and the BRIN index that
-- Drizzle cannot express.
--
-- The whole file is idempotent (IF NOT EXISTS / guarded ALTERs) so it can be
-- re-applied without error.

CREATE TABLE IF NOT EXISTS bonus_transactions (
  id              bigserial   NOT NULL,
  player_id       uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount          integer     NOT NULL,
  type            text        NOT NULL,
  reference_type  text,
  reference_id    text,
  comment         text,
  actor_player_id uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bonus_transactions_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT bonus_transactions_type_chk
    CHECK (type IN ('earn_online','earn_boost','earn_seed','spend','adjust')),
  CONSTRAINT bonus_transactions_amount_nonzero_chk CHECK (amount <> 0)
) PARTITION BY RANGE (created_at);

-- Idempotent accruals: the logical key is (player_id, type, reference_type,
-- reference_id). Postgres requires the partition column in any unique index on
-- a partitioned table, so created_at is appended; the ECON-2 worker pins an
-- accrual's created_at to the accrued day (00:00 UTC), keeping the 5-column key
-- equivalent to the 4-column logical key. Manual spend/adjust rows leave
-- reference_id NULL and never collide.
CREATE UNIQUE INDEX IF NOT EXISTS bonus_transactions_accrual_idempotency_idx
  ON bonus_transactions (player_id, type, reference_type, reference_id, created_at);
CREATE INDEX IF NOT EXISTS bonus_transactions_player_created_idx
  ON bonus_transactions (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bonus_transactions_created_at_brin_idx
  ON bonus_transactions USING brin (created_at) WITH (pages_per_range = 32);

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
    part_name  := 'bonus_transactions_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF bonus_transactions FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;

-- Denormalized balance, updated in the same transaction as every ledger insert.
-- The CHECK backstops the transactional guard that forbids balance < 0.
ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_balance integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'players_bonus_balance_nonneg_chk'
  ) THEN
    ALTER TABLE players ADD CONSTRAINT players_bonus_balance_nonneg_chk CHECK (bonus_balance >= 0);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Production rotation (pg_partman). Not run in CI because pg_partman is not
-- installed on the CI Postgres image; the orchestrator enables it in the
-- production migration:
--
--   CREATE EXTENSION IF NOT EXISTS pg_partman;
--   SELECT partman.create_parent(
--     p_parent_table    => 'public.bonus_transactions',
--     p_control         => 'created_at',
--     p_type            => 'range',
--     p_interval        => '1 month',
--     p_premake         => 3
--   );
--   UPDATE partman.part_config
--   SET retention             = '24 months',
--       retention_keep_table  = false,
--       infinite_time_partitions = true
--   WHERE parent_table = 'public.bonus_transactions';
--
-- pg_cron then runs SELECT partman.run_maintenance() hourly.
-- ---------------------------------------------------------------------------
