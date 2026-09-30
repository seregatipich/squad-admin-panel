import {
  ANALYTICS_WINDOW_PRESETS,
  analyticsWindowRange,
  buildAnalyticsWindowQuery,
} from '@/lib/analytics-window';

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

export const WINDOW_PRESETS = ANALYTICS_WINDOW_PRESETS;

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

export { formatDurationRu, formatHours } from '@/lib/format';

export const buildAnalyticsQuery = buildAnalyticsWindowQuery;
export const windowRange = analyticsWindowRange;
