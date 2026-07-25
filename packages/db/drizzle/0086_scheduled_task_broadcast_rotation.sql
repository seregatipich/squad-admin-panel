-- MSG-4 (#187): rotation cursor for scheduled `broadcast` tasks. When a task
-- carries several messages (`params.messages`), the scheduler dispatches them
-- in turn — `rotation_index` records which entry fires next and is advanced
-- after each successful broadcast (see
-- apps/workers/scheduler/src/scheduled-task-tick.ts). Single-message and
-- non-broadcast tasks leave it at 0. See
-- packages/db/src/schema/scheduled-tasks.ts.
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS rotation_index integer NOT NULL DEFAULT 0;
--> statement-breakpoint
