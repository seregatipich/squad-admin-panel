import { z } from 'zod';

/**
 * Whether `day` (`YYYY-MM-DD`) names a real calendar day in UTC. A shape-only
 * regex lets `2026-13-45` through to Postgres (`::date` → 500) and lets
 * `Date.parse` silently roll `2026-02-30` over to `2026-03-02`.
 *
 * @param day - Candidate day string.
 * @returns `true` only when the date round-trips unchanged.
 */
export function isCalendarDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** Zod schema for a `YYYY-MM-DD` query parameter that must be a real calendar day. */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDay, { message: 'must be a calendar day (YYYY-MM-DD)' });
