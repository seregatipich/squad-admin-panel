-- ECON-1: bonus_transactions (monthly partitioned ledger) + players.bonus_balance.

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

CREATE UNIQUE INDEX IF NOT EXISTS bonus_transactions_accrual_idempotency_idx
  ON bonus_transactions (player_id, type, reference_type, reference_id, created_at);
CREATE INDEX IF NOT EXISTS bonus_transactions_player_created_idx
  ON bonus_transactions (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bonus_transactions_created_at_brin_idx
  ON bonus_transactions USING brin (created_at) WITH (pages_per_range = 32);

-- Look-back widened to 6 months (from 1) so fixture data in tests migrated
-- well after this file was authored still lands in a partition that exists;
-- see the matching comment on the events bootstrap in 0000_init.sql.
DO $$
DECLARE m int; cur_month date := date_trunc('month', now())::date; part_start date; part_end date; part_name text;
BEGIN
  FOR m IN -6..3 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end := part_start + interval '1 month';
    part_name := 'bonus_transactions_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF bonus_transactions FOR VALUES FROM (%L) TO (%L)', part_name, part_start, part_end);
  END LOOP;
END$$;

ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_balance integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_bonus_balance_nonneg_chk') THEN
    ALTER TABLE players ADD CONSTRAINT players_bonus_balance_nonneg_chk CHECK (bonus_balance >= 0);
  END IF;
END$$;
