import {
  ANALYTICS_WINDOW_PRESETS,
  analyticsWindowRange,
  buildAnalyticsWindowQuery,
  formatTrendDay,
  maxOrOne,
} from '@/lib/analytics-window';

export type { VoteAnalytics } from '@squad/shared-types';

export const VOTE_WINDOW_PRESETS = ANALYTICS_WINDOW_PRESETS;

export function formatVoteHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function formatPassRate(rate: number): string {
  return `${String(Math.round(rate * 10) / 10).replace('.', ',')}%`;
}

/**
 * Тон дизайн-системы для доли успешных голосований.
 *
 * Возвращается состояние (`good`/`warn`/`crit`), а не готовый CSS-класс: тон
 * подставляется и в `StatTile`, и в `Badge`, а те сами знают, каким цветом его
 * показать и как продублировать текстом (§5 дизайн-системы).
 *
 * @param rate Доля успешных в процентах.
 * @returns `good` от 66%, `warn` от 33%, иначе `crit`.
 */
export function passRateTone(rate: number): 'good' | 'warn' | 'crit' {
  if (rate >= 66) return 'good';
  if (rate >= 33) return 'warn';
  return 'crit';
}

export function trendScale(trend: Array<{ count: number }>): number {
  return maxOrOne(trend.map((entry) => entry.count));
}

export function hourScale(byHour: Array<{ count: number }>): number {
  return maxOrOne(byHour.map((entry) => entry.count));
}

export { formatTrendDay };

export const buildVotesQuery = buildAnalyticsWindowQuery;
export const voteWindowRange = analyticsWindowRange;
