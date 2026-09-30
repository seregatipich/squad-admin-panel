/**
 * Helpers shared by the dashboard, vote and report analytics panels: the
 * window presets, the query string of `/api/v1/*-analytics`, the rolling
 * window range and the trend-axis helpers. Each panel keeps its own thin,
 * named re-exports so call sites read in the panel's vocabulary.
 */

export const ANALYTICS_WINDOW_PRESETS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
] as const;

export interface AnalyticsQueryParams {
  serverId?: string | null;
  from?: string;
  to?: string;
  format?: 'json' | 'csv';
}

/**
 * Builds the query string of an analytics endpoint.
 *
 * @returns `?server_id=...&from=...` or an empty string when no parameter is set.
 */
export function buildAnalyticsWindowQuery(params: AnalyticsQueryParams): string {
  const query = new URLSearchParams();
  if (params.serverId) query.set('server_id', params.serverId);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.format) query.set('format', params.format);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

/** The `[now - days, now]` window as ISO timestamps. */
export function analyticsWindowRange(
  days: number,
  now: Date = new Date(),
): { from: string; to: string } {
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** The largest value of a series, or 1 for an empty or all-zero series (a safe bar-chart divisor). */
export function maxOrOne(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0) || 1;
}

/**
 * Formats a UTC calendar day (`YYYY-MM-DD`) as `dd.mm`.
 *
 * The API sends `day` already as a UTC date, so it is formatted in UTC: the
 * browser's local zone would shift it (a negative offset renders the day before).
 */
export function formatTrendDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}
