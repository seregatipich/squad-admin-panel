/**
 * Date-range presets shared by the matches, combat-log, events and votes
 * filters. Keeping the preset semantics (local-time day boundaries, rolling
 * windows) in one module means a change to them lands on every page at once.
 */

/** Presets every date-filtered page offers. */
export type CommonDatePreset =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | '30days'
  | 'all'
  | 'custom';

/** Every preset some page offers; pages narrow this to the subset they show. */
export type AnyDatePreset = CommonDatePreset | '24h' | '60days' | '90days';

/** Russian labels of the presets offered by the matches, events and votes pages. */
export const COMMON_DATE_PRESETS: Array<{ value: CommonDatePreset; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: '30days', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
  { value: 'custom', label: 'Произвольно' },
];

/** Half-open bounds sent to the API; a missing side means "unbounded". */
export interface DateRange {
  dateFrom?: Date;
  dateTo?: Date;
}

/** The filter fields that determine a range: a preset plus `YYYY-MM-DD` custom bounds. */
export interface DateRangeInput {
  preset: AnyDatePreset;
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(0, 0, 0, 0);
  return day;
}

function endOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(23, 59, 59, 999);
  return day;
}

function addDays(reference: Date, amount: number): Date {
  const shifted = new Date(reference);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const parsed = new Date(year, month - 1, day);
  // `new Date(2024, 1, 31)` rolls over to 2 March: reject days that do not exist.
  const isRealDay =
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  return isRealDay ? parsed : null;
}

/**
 * Resolves a filter's preset (or custom `from`/`to` day strings) into concrete
 * bounds in the viewer's local time zone. `all` and unknown presets yield an
 * empty range.
 */
export function resolveDateRange(input: DateRangeInput, now: Date = new Date()): DateRange {
  switch (input.preset) {
    case 'today':
      return { dateFrom: startOfDay(now), dateTo: now };
    case 'yesterday': {
      const from = addDays(startOfDay(now), -1);
      return { dateFrom: from, dateTo: endOfDay(from) };
    }
    case '24h':
      return { dateFrom: new Date(now.getTime() - DAY_MS), dateTo: now };
    case 'week':
      return { dateFrom: addDays(startOfDay(now), -6), dateTo: now };
    case 'month':
      return { dateFrom: new Date(now.getFullYear(), now.getMonth(), 1), dateTo: now };
    case '30days':
      return { dateFrom: new Date(now.getTime() - 30 * DAY_MS), dateTo: now };
    case '60days':
      return { dateFrom: new Date(now.getTime() - 60 * DAY_MS), dateTo: now };
    case '90days':
      return { dateFrom: new Date(now.getTime() - 90 * DAY_MS), dateTo: now };
    case 'custom': {
      const range: DateRange = {};
      const from = parseDateInput(input.from);
      const to = parseDateInput(input.to);
      if (from) range.dateFrom = startOfDay(from);
      if (to) range.dateTo = endOfDay(to);
      return range;
    }
    default:
      return {};
  }
}
