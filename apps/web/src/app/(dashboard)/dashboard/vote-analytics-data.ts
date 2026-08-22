export interface VoteAnalytics {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total_votes: number;
    passed: number;
    failed: number;
    cancelled: number;
    pass_rate: number;
  };
  pass_rate_by_server: Array<{
    server_id: string;
    server_name: string | null;
    total: number;
    passed: number;
    pass_rate: number;
  }>;
  pass_rate_by_map: Array<{ map: string; total: number; passed: number; pass_rate: number }>;
  trend: Array<{ day: string; count: number }>;
  top_initiators: Array<{
    player_id: string;
    nickname: string | null;
    initiated: number;
    passed: number;
    success_ratio: number;
  }>;
  by_hour: Array<{ hour: number; count: number }>;
  serial_skippers: Array<{ player_id: string; nickname: string | null; skip_count: number }>;
}

export const VOTE_WINDOW_PRESETS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
] as const;

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
  return trend.reduce((max, entry) => Math.max(max, entry.count), 0) || 1;
}

export function hourScale(byHour: Array<{ count: number }>): number {
  return byHour.reduce((max, entry) => Math.max(max, entry.count), 0) || 1;
}

export function formatTrendDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export function buildVotesQuery(params: {
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

export function voteWindowRange(
  days: number,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now;
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
