/**
 * Hand-rolled standard 5-field cron matcher (`minute hour day-of-month month
 * day-of-week`), evaluated in UTC. No `cron-parser` dependency: this single
 * pure module is shared by the seed-schedule API validation
 * (`apps/api/src/routes/server-seed-schedule.ts`), the scheduler worker tick
 * (`apps/workers/scheduler/src/seed-schedule-tick.ts`), and the web calendar
 * (`apps/web/src/app/(dashboard)/servers/[id]/seed-calendar/helpers.ts`) so
 * all three agree on identical semantics — see SEED-3 (#142).
 *
 * Supported syntax per field: `*`, a single integer, a comma-separated list
 * of integers, and a step (`star-slash-n` or `start-slash-n`). Ranges (`a-b`) and
 * non-standard extensions (`L`, `W`, `#`) are deliberately NOT supported —
 * an expression using them is rejected by {@link parseCron5}.
 *
 * Day-of-month and day-of-week combine with the classic cron OR semantics:
 * when both fields are restricted (not `*`), an occurrence matches if
 * EITHER field matches (not both).
 */

export interface Cron5Expression {
  minute: readonly number[] | null;
  hour: readonly number[] | null;
  dayOfMonth: readonly number[] | null;
  month: readonly number[] | null;
  /** 0 = Sunday, per JS `Date#getUTCDay()`. */
  dayOfWeek: readonly number[] | null;
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
  if (values.size === 0) {
    throw new Error(`invalid cron field "${raw}": no values parsed`);
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
  if (domRestricted && dowRestricted) {
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
