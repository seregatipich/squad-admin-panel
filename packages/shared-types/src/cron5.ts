/**
 * Hand-rolled standard 5-field cron matcher (`minute hour day-of-month month
 * day-of-week`), evaluated in UTC. No `cron-parser` dependency: this single
 * pure module is shared by the seed-schedule API validation
 * (`apps/api/src/routes/server-seed-schedule.ts`) and the scheduler worker
 * tick (`apps/workers/scheduler/src/seed-schedule-tick.ts`) so both agree on
 * identical semantics — see SEED-3 (#142). The web calendar that was the
 * third consumer is gone; the schedule itself is still applied by the tick.
 *
 * Supported syntax per field: `*`, a single integer, a comma-separated list
 * of integers, and a step (`star-slash-n` or `start-slash-n`). Ranges (`a-b`) and
 * non-standard extensions (`L`, `W`, `#`) are deliberately NOT supported —
 * an expression using them is rejected by {@link parseCron5}.
 *
 * Day-of-month and day-of-week combine with the classic cron OR semantics:
 * when both fields are restricted (neither starts with `*`), an occurrence
 * matches if EITHER field matches. As in Vixie cron, a field that starts with
 * `*` (including a step such as `*` + `/2`) is not "restricted" for this
 * purpose: the two fields are then ANDed.
 */

export interface Cron5Expression {
  minute: readonly number[] | null;
  hour: readonly number[] | null;
  dayOfMonth: readonly number[] | null;
  month: readonly number[] | null;
  /** 0 = Sunday, per JS `Date#getUTCDay()`. */
  dayOfWeek: readonly number[] | null;
  /** True when the day-of-month field started with `*` (bare or stepped). */
  dayOfMonthStar?: boolean;
  /** True when the day-of-week field started with `*` (bare or stepped). */
  dayOfWeekStar?: boolean;
}

function parseField(raw: string, min: number, max: number): number[] | null {
  if (raw === '*') return null;

  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = /^(\*|\d+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const startToken = stepMatch[1];
      const stepToken = stepMatch[2];
      const start = startToken === '*' ? min : Number(startToken);
      const step = Number(stepToken);
      if (step <= 0 || start < min || start > max) {
        throw new Error(`invalid cron field "${raw}": step out of range`);
      }
      for (let v = start; v <= max; v += step) values.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`invalid cron field "${raw}": unsupported syntax "${part}"`);
    }
    const value = Number(part);
    if (value < min || value > max) {
      throw new Error(`invalid cron field "${raw}": ${value} out of range [${min},${max}]`);
    }
    values.add(value);
  }
  return Array.from(values).sort((a, b) => a - b);
}

/** Parses a 5-field cron expression. Throws on any malformed/unsupported field. */
export function parseCron5(expression: string): Cron5Expression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      'cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week',
    );
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseField(minuteRaw, 0, 59),
    hour: parseField(hourRaw, 0, 23),
    dayOfMonth: parseField(domRaw, 1, 31),
    month: parseField(monthRaw, 1, 12),
    dayOfWeek: parseField(dowRaw, 0, 6),
    dayOfMonthStar: domRaw.startsWith('*'),
    dayOfWeekStar: dowRaw.startsWith('*'),
  };
}

/** True when `expression` parses as a valid 5-field cron expression. */
export function isValidCron5(expression: string): boolean {
  try {
    parseCron5(expression);
    return true;
  } catch {
    return false;
  }
}

/** Whether `date` (evaluated in UTC) matches a parsed cron expression. */
export function cron5Matches(expr: Cron5Expression, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  if (expr.minute && !expr.minute.includes(minute)) return false;
  if (expr.hour && !expr.hour.includes(hour)) return false;
  if (expr.month && !expr.month.includes(month)) return false;

  const domRestricted = expr.dayOfMonth !== null;
  const dowRestricted = expr.dayOfWeek !== null;
  if (domRestricted && dowRestricted && !expr.dayOfMonthStar && !expr.dayOfWeekStar) {
    const domMatch = expr.dayOfMonth?.includes(dayOfMonth) ?? false;
    const dowMatch = expr.dayOfWeek?.includes(dayOfWeek) ?? false;
    if (!domMatch && !dowMatch) return false;
  } else if (domRestricted && !expr.dayOfMonth?.includes(dayOfMonth)) {
    return false;
  } else if (dowRestricted && !expr.dayOfWeek?.includes(dayOfWeek)) {
    return false;
  }
  return true;
}

const MAX_EXPANSION_MINUTES = 60 * 24 * 40; // ~40 days safety cap

/**
 * Expands every matching minute-granularity occurrence of `expression` in
 * `[from, to]` inclusive (both UTC instants). Seconds/ms of `from` are
 * truncated down to the minute boundary. Capped at ~40 days of iteration to
 * bound worst-case cost for a pathological range.
 */
export function expandCron5Occurrences(
  expression: string,
  from: Date,
  to: Date,
  maxIterations = MAX_EXPANSION_MINUTES,
): Date[] {
  const parsed = parseCron5(expression);
  const occurrences: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);

  let iterations = 0;
  while (cursor.getTime() <= to.getTime() && iterations < maxIterations) {
    if (cron5Matches(parsed, cursor)) occurrences.push(new Date(cursor.getTime()));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    iterations++;
  }
  return occurrences;
}

/**
 * Day-level cap for {@link findLastCron5Occurrence}: how many calendar days,
 * scanning backward from `to`, it will inspect before giving up. Unlike
 * {@link expandCron5Occurrences}'s minute-by-minute forward scan — which caps
 * out at {@link MAX_EXPANSION_MINUTES} (~40 days) and therefore can never find
 * an occurrence of a quarterly/annual cron expression once the caller's
 * cursor falls further behind `to` than that — a day-level backward scan is
 * cheap enough (at most a few thousand day checks) to cover a multi-year gap.
 */
const MAX_LOOKBACK_DAYS = 366 * 5;

/** True when `date`'s calendar fields (UTC) match the day-portion of `expr` (month, day-of-month, day-of-week). */
function cron5DayMatches(expr: Cron5Expression, date: Date): boolean {
  const month = date.getUTCMonth() + 1;
  if (expr.month && !expr.month.includes(month)) return false;

  const { dayOfMonth: allowedDaysOfMonth, dayOfWeek: allowedDaysOfWeek } = expr;
  const dayOfMonthMatches = allowedDaysOfMonth?.includes(date.getUTCDate()) ?? true;
  const dayOfWeekMatches = allowedDaysOfWeek?.includes(date.getUTCDay()) ?? true;
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (allowedDaysOfMonth && allowedDaysOfWeek) return dayOfMonthMatches || dayOfWeekMatches;
  return dayOfMonthMatches && dayOfWeekMatches;
}

/**
 * Finds the single most recent occurrence of `expression` in `[from, to]`
 * (inclusive, UTC), or `null` when none falls in that window. Used by the
 * scheduler ticks' `resolveDueOccurrence` (seed-schedule-tick.ts,
 * scheduled-task-tick.ts), which only ever need the latest missed occurrence
 * to fire the tick once and advance the cursor past it.
 *
 * Scans backward one calendar day at a time from `to`'s day toward `from`'s
 * day (bounded by {@link MAX_LOOKBACK_DAYS}), cheaply testing only the
 * month/day-of-month/day-of-week fields per day; once a day's date fields
 * match, every matching hour:minute in that day is checked in descending
 * order (clamped to `[from, to]` for the first and last day) and the first
 * hit — the latest one — is returned immediately. This makes the cost
 * independent of how long `from` has trailed behind `to`, unlike
 * {@link expandCron5Occurrences}'s minute-granularity forward scan.
 */
export function findLastCron5Occurrence(expression: string, from: Date, to: Date): Date | null {
  if (from.getTime() > to.getTime()) return null;
  const parsed = parseCron5(expression);

  const fromFloor = new Date(from.getTime());
  fromFloor.setUTCSeconds(0, 0);
  const toFloor = new Date(to.getTime());
  toFloor.setUTCSeconds(0, 0);

  const minutes = parsed.minute ? [...parsed.minute].sort((a, b) => b - a) : null;
  const hours = parsed.hour ? [...parsed.hour].sort((a, b) => b - a) : null;

  const day = new Date(toFloor.getTime());
  day.setUTCHours(0, 0, 0, 0);
  const fromDay = new Date(fromFloor.getTime());
  fromDay.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < MAX_LOOKBACK_DAYS && day.getTime() >= fromDay.getTime(); i++) {
    if (cron5DayMatches(parsed, day)) {
      const candidateHours = hours ?? Array.from({ length: 24 }, (_, h) => 23 - h);
      for (const hour of candidateHours) {
        const candidateMinutes = minutes ?? Array.from({ length: 60 }, (_, m) => 59 - m);
        for (const minute of candidateMinutes) {
          const candidate = new Date(day.getTime());
          candidate.setUTCHours(hour, minute, 0, 0);
          if (candidate.getTime() < fromFloor.getTime()) continue;
          if (candidate.getTime() > toFloor.getTime()) continue;
          return candidate;
        }
      }
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return null;
}

/** Start of the fixed probe window used by {@link minCron5IntervalMinutes}: 2024-12-01T00:00:00Z. */
const PROBE_WINDOW_START_MS = Date.UTC(2024, 11, 1, 0, 0, 0);
/** Length of the probe window, one full 31-day month (December 2024). */
const PROBE_WINDOW_MINUTES = 31 * 24 * 60;

/**
 * Smallest gap, in whole minutes, between two consecutive occurrences of
 * `expression` — the anti-spam floor used to reject too-frequent broadcast
 * rotations (MSG-4, #187). Occurrences are expanded over a fixed 31-day UTC
 * probe window (all of December 2024) so the result is deterministic and
 * independent of "now"; the window is half-open so a strictly monthly
 * expression yields a single occurrence.
 *
 * Returns {@link Number.POSITIVE_INFINITY} when fewer than two occurrences
 * fall in the window (e.g. once-a-month or rarer). Throws (via
 * {@link parseCron5}) when `expression` is malformed.
 */
export function minCron5IntervalMinutes(expression: string): number {
  const from = new Date(PROBE_WINDOW_START_MS);
  const to = new Date(PROBE_WINDOW_START_MS + (PROBE_WINDOW_MINUTES - 1) * 60_000);
  const occurrences = expandCron5Occurrences(expression, from, to, PROBE_WINDOW_MINUTES);
  if (occurrences.length < 2) return Number.POSITIVE_INFINITY;

  let min = Number.POSITIVE_INFINITY;
  let previous: Date | undefined;
  for (const current of occurrences) {
    if (previous) {
      const delta = (current.getTime() - previous.getTime()) / 60_000;
      if (delta < min) min = delta;
    }
    previous = current;
  }
  return min;
}
