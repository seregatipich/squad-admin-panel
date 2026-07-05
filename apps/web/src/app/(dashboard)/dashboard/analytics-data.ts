export interface DashboardAnalytics {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total_matches: number;
    total_online_hours: number;
    unique_players: number;
    avg_match_duration_seconds: number | null;
  };
  peak_by_hour: Array<{ hour: number; peak_players: number }>;
  match_outcomes: {
    team1: number;
    team2: number;
    draw: number;
    unknown: number;
    total: number;
  };
  popular_maps: Array<{ map: string; matches: number }>;
  popular_layers: Array<{ layer: string; matches: number }>;
}

export type OutcomeKey = 'team1' | 'team2' | 'draw' | 'unknown';

export const WINDOW_PRESETS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
] as const;

const OUTCOME_LABELS: Record<OutcomeKey, string> = {
  team1: 'Команда 1',
  team2: 'Команда 2',
  draw: 'Ничья',
  unknown: 'Неизвестно',
};

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function peakScale(peakByHour: Array<{ peak_players: number }>): number {
  return peakByHour.reduce((max, entry) => Math.max(max, entry.peak_players), 0) || 1;
}

export function winnerLabelRu(key: OutcomeKey): string {
  return OUTCOME_LABELS[key];
}

export interface OutcomeSegment {
  key: OutcomeKey;
  label: string;
  count: number;
  percent: number;
}

export function outcomeSegments(outcomes: DashboardAnalytics['match_outcomes']): OutcomeSegment[] {
  const total = outcomes.total;
  const keys: OutcomeKey[] = ['team1', 'team2', 'draw', 'unknown'];
  return keys.map((key) => {
    const count = outcomes[key];
    return {
      key,
      label: OUTCOME_LABELS[key],
      count,
      percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
}

export function formatDurationRu(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} сек`;
  return `${minutes} мин ${String(rest).padStart(2, '0')} сек`;
}

export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${String(rounded).replace('.', ',')} ч`;
}

export function buildAnalyticsQuery(params: {
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

export function windowRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = now;
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
