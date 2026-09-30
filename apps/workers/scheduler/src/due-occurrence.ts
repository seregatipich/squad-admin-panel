import { findLastCron5Occurrence, type RconOperatorCommandName } from '@squad/shared-types';

/** Operator RCON command queued onto worker-rcon's command stream. */
export interface SendRconCommandInput {
  serverId: string;
  command: RconOperatorCommandName;
  args: string[];
}

/** The scheduling fields shared by `seed_schedule` and `scheduled_tasks` rows. */
export interface CronScheduleFields {
  /** 5-field cron expression, UTC. Null = one-off. */
  recurrence: string | null;
  /** One-off execution instant; null when the row has none (never due). */
  oneOffAt: Date | null;
  lastExecutedAt: Date | null;
  createdAt: Date;
}

/**
 * Resolves the single cron/one-off occurrence (if any) that is due as of `now`,
 * or `null` when nothing is due.
 *
 * - One-off (`recurrence === null`): due once `oneOffAt <= now`, and only if it
 *   has never executed (`lastExecutedAt === null`).
 * - Recurring: due when {@link findLastCron5Occurrence} finds a matching
 *   minute strictly after the last-known cursor (`lastExecutedAt`, or
 *   `createdAt` if it has never executed) and at or before `now`. When several
 *   occurrences were missed between ticks only the most recent is returned —
 *   the tick fires once, advancing the cursor past every missed occurrence,
 *   however far behind the cursor has fallen (a quarterly or annual cron stays
 *   due after months of downtime).
 */
export function resolveCronDueOccurrence(schedule: CronScheduleFields, now: Date): Date | null {
  if (schedule.recurrence === null) {
    if (schedule.oneOffAt === null || schedule.lastExecutedAt !== null) return null;
    return schedule.oneOffAt.getTime() <= now.getTime() ? schedule.oneOffAt : null;
  }

  const hasPriorOccurrence = schedule.lastExecutedAt !== null;
  const cursor = schedule.lastExecutedAt ?? schedule.createdAt;
  // The prior cursor (when it is itself a previously-fired occurrence) must
  // be excluded from the scan window, or the same minute would re-match.
  const from = hasPriorOccurrence ? new Date(cursor.getTime() + 60_000) : cursor;
  if (from.getTime() > now.getTime()) return null;

  return findLastCron5Occurrence(schedule.recurrence, from, now);
}
