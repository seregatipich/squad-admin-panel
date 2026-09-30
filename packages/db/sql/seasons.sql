-- LEAD-7 (#178): hand-written DDL for the `seasons` table.
--
-- Kept alongside the migration because two constraints cannot be expressed by
-- `drizzle-kit generate` in a form we would ship unedited:
--
--   * `seasons_one_active` is a PARTIAL unique index over a constant
--     expression. It is what enforces "at most one active season" at the
--     storage layer, so the aggregator and the API can resolve the active
--     season with a bare `LIMIT 1` instead of defensively ordering.
--   * `seasons_bounds_chk` / `seasons_status_chk` are table CHECKs.
--
-- Applied by packages/db/drizzle/0102_seasons.sql; this file is the reference
-- copy for review and for re-creating the table by hand.

CREATE TABLE IF NOT EXISTS seasons (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'upcoming',
  finalized   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_bounds_chk CHECK (ends_at > starts_at),
  CONSTRAINT seasons_status_chk CHECK (status IN ('upcoming', 'active', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS seasons_name_key ON seasons (name);

-- At most one active season, ever.
CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_active ON seasons ((status)) WHERE status = 'active';

-- Lookup path used by the aggregator tick and the leaderboards route.
CREATE INDEX IF NOT EXISTS seasons_status_idx ON seasons (status, starts_at);

-- Two seasons cannot start on the same UTC day (#84/#576): the leaderboards
-- route resolves a season purely from its `period_start` day
-- (`(starts_at AT TIME ZONE 'UTC')::date = period_start::date` in
-- apps/api/src/routes/leaderboards.ts), and the web UI's season picker keys
-- options and the URL's `?start=` the same way (`seasonPeriodStart` in
-- apps/web/src/app/(dashboard)/leaderboards/helpers.ts). Without this
-- constraint two same-day seasons would be indistinguishable to both.
CREATE UNIQUE INDEX IF NOT EXISTS seasons_start_day_key
  ON seasons ((( starts_at AT TIME ZONE 'UTC')::date));
