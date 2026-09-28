/**
 * What a schedule edit must do to a row's `last_executed_at`, which the
 * scheduler worker uses as its cursor (`resolveDueOccurrence` in
 * `apps/workers/scheduler/src/scheduled-task-tick.ts` and
 * `seed-schedule-tick.ts`):
 *
 * - a recurring row scans for occurrences after the cursor and fires the
 *   latest one it finds, however old;
 * - a one-off row never fires again once the cursor is set.
 */
export interface ScheduleEdit {
  /** The start time or the recurrence actually changed. */
  scheduleChanged: boolean;
  /** The row goes from disabled to enabled. */
  reenabled: boolean;
  /** The row is recurring after the edit. */
  recurring: boolean;
  /** Time of the edit. */
  now: Date;
}

/**
 * Returns the cursor value the edit must store, or `undefined` to keep it.
 *
 * A recurring row that is re-timed or re-enabled gets a cursor at the start of
 * the current minute (the worker stores minute-aligned occurrences), so missed
 * occurrences are not replayed and the next one still fires. A one-off row
 * whose time changes gets `null`, so it fires at its new time even if it
 * already ran.
 *
 * @param edit - What the edit changes.
 * @returns The new `last_executed_at`, or `undefined` for "leave unchanged".
 */
export function rescheduledCursor(edit: ScheduleEdit): Date | null | undefined {
  if (edit.recurring) {
    if (!edit.scheduleChanged && !edit.reenabled) return undefined;
    return new Date(Math.floor(edit.now.getTime() / 60_000) * 60_000);
  }
  return edit.scheduleChanged ? null : undefined;
}
