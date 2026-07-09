-- REPORT-2 (#112): can_handle_reports role flag gates the report moderation
-- queue API (GET/PATCH /api/v1/reports). Owner is backfilled per the
-- established pattern for access-flag migrations (see 0027_econ_settings_and_flag.sql).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS can_handle_reports boolean NOT NULL DEFAULT false;
UPDATE roles SET can_handle_reports = true WHERE name = 'Owner';
