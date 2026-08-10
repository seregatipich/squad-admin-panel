import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/** Server action a scheduled task performs when it becomes due. */
export const SCHEDULED_TASK_TYPES = [
  'restart',
  'set_next_layer',
  'change_layer',
  'broadcast',
] as const;
export type ScheduledTaskType = (typeof SCHEDULED_TASK_TYPES)[number];

/** Outcome of a single scheduled-task execution attempt. */
export const SCHEDULED_TASK_RUN_STATUSES = ['executed', 'skipped_depot_update', 'failed'] as const;
export type ScheduledTaskRunStatus = (typeof SCHEDULED_TASK_RUN_STATUSES)[number];

/** Structured parameters carried by a task, discriminated by `task_type`. */
export interface ScheduledTaskParams {
  /** Target layer for `set_next_layer` / `change_layer`. */
  layer?: string;
  /** Broadcast text for a single-message `broadcast` (legacy/one-message form). */
  message?: string;
  /**
   * Ordered rotation of broadcast texts (MSG-4, #187). Present only when a
   * `broadcast` task carries more than one message; the scheduler fires them in
   * turn using {@link scheduledTasks.rotationIndex}. A single message is stored
   * as {@link ScheduledTaskParams.message} instead.
   */
  messages?: string[];
  /** Optional MSG-1 template ids the rotation `messages` were substituted from. */
  templateIds?: string[];
}

/**
 * scheduled_tasks (AUTO-2, #73): general server actions run on a schedule by
 * `@squad/worker-scheduler` (`apps/workers/scheduler/src/scheduled-task-tick.ts`)
 * and managed via `/api/v1/servers/:id/scheduled-tasks`. Unlike the
 * feature-specific `seed_schedule` / `rotation_schedule` tables, a single row
 * here can perform any of the {@link SCHEDULED_TASK_TYPES} actions — restart
 * (SRV-3 container restart), `set_next_layer` / `change_layer`
 * (`AdminSetNextLayer` / `AdminChangeLayer`), or `broadcast` (`AdminBroadcast`)
 * — with the action's arguments in `params` (see {@link ScheduledTaskParams}).
 *
 * A row schedules either a one-off `scheduled_at` instant or a recurring
 * 5-field cron `recurrence` (evaluated in UTC by `@squad/shared-types`'s
 * `cron5.ts`); the check constraint requires at least one to be set.
 *
 * `lastExecutedAt` is the execution-dedup cursor with the same semantics as
 * `seed_schedule.last_executed_at`: a one-off task fires once it is set; a
 * recurring task fires every cron occurrence strictly after `lastExecutedAt`
 * (or `createdAt` if never yet executed) up to "now". Depot-update overlap
 * skips execution without advancing the cursor, so the occurrence retries.
 */
export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    taskType: text('task_type').$type<ScheduledTaskType>().notNull(),
    params: jsonb('params').$type<ScheduledTaskParams>().notNull().default({}),
    /** One-off execution instant. Null when the task is purely recurring. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }),
    /** 5-field cron expression (minute hour day-of-month month day-of-week), UTC. Null = one-off. */
    recurrence: text('recurrence'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Rotation cursor for multi-message `broadcast` tasks (MSG-4, #187): the
     * index into `params.messages` that fires next, advanced after each
     * successful broadcast. 0 for single-message and non-broadcast tasks.
     */
    rotationIndex: integer('rotation_index').notNull().default(0),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverScheduledIdx: index('scheduled_tasks_server_scheduled_idx').on(
      table.serverId,
      table.scheduledAt,
    ),
    taskTypeCheck: check(
      'scheduled_tasks_task_type_check',
      sql`task_type IN ('restart','set_next_layer','change_layer','broadcast')`,
    ),
    scheduleCheck: check(
      'scheduled_tasks_schedule_check',
      sql`scheduled_at IS NOT NULL OR recurrence IS NOT NULL`,
    ),
  }),
);

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

/**
 * scheduled_task_runs (AUTO-2, #73): append-only execution history for
 * `scheduled_tasks`. One row per attempt the scheduler tick makes — `executed`
 * once the action is dispatched, `skipped_depot_update` when a depot update was
 * in progress, or `failed` when dispatch threw. `detail` carries per-status
 * context (occurrence, resolved command, error message).
 */
export const scheduledTaskRuns = pgTable(
  'scheduled_task_runs',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    status: text('status').$type<ScheduledTaskRunStatus>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
  },
  (table) => ({
    taskExecutedIdx: index('scheduled_task_runs_task_executed_idx').on(
      table.taskId,
      table.executedAt,
    ),
    statusCheck: check(
      'scheduled_task_runs_status_check',
      sql`status IN ('executed','skipped_depot_update','failed')`,
    ),
  }),
);

export type ScheduledTaskRunRow = typeof scheduledTaskRuns.$inferSelect;
export type NewScheduledTaskRun = typeof scheduledTaskRuns.$inferInsert;
