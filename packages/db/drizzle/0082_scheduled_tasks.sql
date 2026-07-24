-- AUTO-2 (#73): general scheduled-task system — run server actions (restart,
-- set_next_layer/change_layer, broadcast) on a one-off instant or a recurring
-- 5-field cron. Executed by @squad/worker-scheduler
-- (apps/workers/scheduler/src/scheduled-task-tick.ts) and managed via
-- /api/v1/servers/:id/scheduled-tasks. See
-- packages/db/src/schema/scheduled-tasks.ts.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  task_type text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz,
  recurrence text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES players(id) ON DELETE SET NULL,
  last_executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_tasks_task_type_check
    CHECK (task_type IN ('restart','set_next_layer','change_layer','broadcast')),
  CONSTRAINT scheduled_tasks_schedule_check
    CHECK (scheduled_at IS NOT NULL OR recurrence IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_server_scheduled_idx
  ON scheduled_tasks (server_id, scheduled_at);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  executed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  detail jsonb,
  CONSTRAINT scheduled_task_runs_status_check
    CHECK (status IN ('executed','skipped_depot_update','failed'))
);
CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_executed_idx
  ON scheduled_task_runs (task_id, executed_at);
