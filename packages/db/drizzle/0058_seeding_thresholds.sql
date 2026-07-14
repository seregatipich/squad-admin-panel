-- SEED-1 (#140): per-server seeding thresholds used by worker-rcon's
-- seeding state machine (apps/workers/rcon/src/seeding.ts) and exposed via
-- GET/PUT /api/v1/servers/:id/seeding[-settings].
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS seed_live_at integer NOT NULL DEFAULT 60;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS seed_hysteresis integer NOT NULL DEFAULT 5;
