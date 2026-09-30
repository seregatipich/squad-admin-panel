-- Two seasons cannot start on the same UTC day (#84/#576): the leaderboards
-- route resolves a season purely from its `period_start` day
-- (`(starts_at AT TIME ZONE 'UTC')::date = period_start::date` in
-- apps/api/src/routes/leaderboards.ts), and the web UI's season picker keys
-- options and the URL's `?start=` the same way (`seasonPeriodStart` in
-- apps/web/src/app/(dashboard)/leaderboards/helpers.ts). Without this
-- constraint two same-day seasons would be indistinguishable to both.
--
-- Rollback-safe: forward-only, additive index. The previous release never
-- queries by this index, so a rollback simply stops using it.
CREATE UNIQUE INDEX IF NOT EXISTS seasons_start_day_key
  ON seasons ((( starts_at AT TIME ZONE 'UTC')::date));
