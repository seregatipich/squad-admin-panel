-- SEED-3 (#142): planned/recurring seed-layer starts, executed by
-- @squad/worker-scheduler (apps/workers/scheduler/src/seed-schedule-tick.ts)
-- and managed via /api/v1/servers/:id/seed-schedule (changemap squad
-- permission). See packages/db/src/schema/seed-schedule.ts.
CREATE TABLE IF NOT EXISTS seed_schedule (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  seed_layer text NOT NULL,
  broadcast_text text,
  recurrence text,
  created_by uuid REFERENCES players(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seed_schedule_server_starts_idx
  ON seed_schedule (server_id, starts_at);
