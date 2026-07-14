/**
 * Types and pure helpers for the REPORT-5 (#115) reports analytics panel.
 * Mirrors apps/web/src/app/(dashboard)/dashboard/vote-analytics-data.ts.
 */
export interface ReportAnalytics {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total: number;
    by_status: { pending: number; in_review: number; resolved: number; rejected: number };
    avg_resolution_seconds: number | null;
    median_resolution_seconds: number | null;
  };
  trend: Array<{ day: string; count: number }>;
  by_server: Array<{
    server_id: string;
    server_name: string | null;
    total: number;
    resolved: number;
    rejected: number;
  }>;
  by_handler: Array<{
    player_id: string;
    name: string | null;
    handled: number;
    resolved: number;
    rejected: number;
    avg_resolution_seconds: number | null;
  }>;
  top_targets: Array<{
    player_id: string;
    name: string | null;
    count_30d: number;
    count_90d: number;
  }>;
  top_reporters: Array<{
    player_id: string;
    name: string | null;
    total: number;
    resolved: number;
    rejected: number;
    confirmed: number;
    accuracy: number;
    trusted: boolean;
    spam_flagged: boolean;
  }>;
}

export const REPORTS_WINDOW_PRESETS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
] as const;

export function reportsWindowRange(
  days: number,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now;
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function buildReportsAnalyticsQuery(params: {
  serverId?: string | null;
  from?: string;
  to?: string;
  format?: 'json' | 'csv';
}): string {
  const query = new URLSearchParams();
  if (params.serverId) query.set('server_id', params.serverId);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.format) query.set('format', params.format);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

export function formatTrendDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/** Formats a duration in seconds as Russian "2 ч 15 м" / "45 с" / "3 м". Null/negative renders "—". */
export function formatDurationRu(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds} с`;

  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} м`;
  if (minutes === 0) return `${hours} ч`;
  return `${hours} ч ${minutes} м`;
}

/** Accuracy (0..1 share) formatted as a Russian percent, e.g. "62,5%". */
export function formatAccuracy(accuracy: number): string {
  const percent = Math.round(accuracy * 1000) / 10;
  return `${String(percent).replace('.', ',')}%`;
}

export function trendScale(trend: Array<{ count: number }>): number {
  return trend.reduce((max, entry) => Math.max(max, entry.count), 0) || 1;
}
