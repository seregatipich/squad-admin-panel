const DAY_MS = 86_400_000;
const DAY_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeriesPoint {
  key: string;
  value: number;
}

/** One plottable metric as served by `GET /api/v1/statistics`. */
export interface StatisticsSeries {
  by_server: Array<{ server_id: string; points: SeriesPoint[] }>;
  totals: SeriesPoint[];
  kpi: { avg: number; max: number; total: number };
}

export interface StatisticsResponse {
  from: string;
  to: string;
  days: string[];
  servers: Array<{ server_id: string; display_name: string }>;
  population: {
    avg_online: StatisticsSeries;
    peak_online: StatisticsSeries;
    avg_queue: StatisticsSeries;
    by_hour: StatisticsSeries;
    by_weekday: StatisticsSeries;
  };
  matches: {
    by_day: StatisticsSeries;
    modes: Array<{ mode: string; matches: number }>;
    maps: Array<{ map: string; matches: number }>;
  };
  community: {
    new_players: StatisticsSeries;
    chat_messages: StatisticsSeries;
    teamkills: StatisticsSeries;
  };
  moderation: {
    punishments: StatisticsSeries;
    avg_admins: StatisticsSeries;
    peak_admins: StatisticsSeries;
  };
}

export type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | '30days' | 'custom';

export const RANGE_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: '30days', label: '30 дней' },
  { value: 'custom', label: 'Произвольно' },
];

export interface StatisticsRange {
  from: string;
  to: string;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
}

function lastNDays(now: Date, days: number): StatisticsRange {
  return {
    from: new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

/**
 * Resolves a preset (or the two custom day inputs) into the ISO `from`/`to`
 * bounds the API expects.
 *
 * A `custom` range whose inputs are missing or not `YYYY-MM-DD` falls back to
 * the last 30 days rather than sending a malformed window.
 *
 * @param preset Selected range preset.
 * @param now Reference clock — must come from a post-mount effect, never from
 *   render, or the server and client markup disagree.
 * @param customFrom `YYYY-MM-DD` start used only by the `custom` preset.
 * @param customTo `YYYY-MM-DD` end used only by the `custom` preset.
 */
export function presetRange(
  preset: RangePreset,
  now: Date,
  customFrom: string,
  customTo: string,
): StatisticsRange {
  const dayStart = startOfUtcDay(now);
  if (preset === 'today') {
    return { from: dayStart.toISOString(), to: now.toISOString() };
  }
  if (preset === 'yesterday') {
    const start = new Date(dayStart.getTime() - DAY_MS);
    return { from: start.toISOString(), to: new Date(dayStart.getTime() - 1).toISOString() };
  }
  if (preset === 'week') return lastNDays(now, 7);
  if (preset === 'month') {
    const first = new Date(
      Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    return { from: first.toISOString(), to: now.toISOString() };
  }
  if (preset === '30days') return lastNDays(now, 30);
  if (!DAY_INPUT_RE.test(customFrom) || !DAY_INPUT_RE.test(customTo)) return lastNDays(now, 30);
  return {
    from: `${customFrom}T00:00:00.000Z`,
    to: `${customTo}T23:59:59.999Z`,
  };
}

/** Builds the `/api/v1/statistics` query string; an empty server list means "all servers". */
export function buildStatisticsQuery(params: {
  from?: string;
  to?: string;
  servers: string[];
  format?: 'json' | 'csv';
}): string {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.servers.length > 0) query.set('servers', params.servers.join(','));
  if (params.format) query.set('format', params.format);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

/**
 * Sums every per-server point of a series — the value a stacked bar chart
 * actually draws. It must equal `series.kpi.total`; the tests assert exactly
 * that, which is acceptance criterion 3.
 */
export function stackedTotal(series: StatisticsSeries): number {
  const total = series.by_server.reduce(
    (sum, entry) => sum + entry.points.reduce((inner, point) => inner + point.value, 0),
    0,
  );
  return Math.round(total * 10) / 10;
}

/** Pivots a series into recharts rows: one row per key, one numeric column per server. */
export function chartRows(
  series: StatisticsSeries,
  serverIds: string[],
): Array<Record<string, string | number>> {
  return series.totals.map((total) => {
    const row: Record<string, string | number> = { key: total.key };
    for (const serverId of serverIds) {
      const entry = series.by_server.find((s) => s.server_id === serverId);
      row[serverId] = entry?.points.find((p) => p.key === total.key)?.value ?? 0;
    }
    return row;
  });
}

/** Formats a metric for the KPI strip: integers bare, fractions to one comma-separated decimal. */
export function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

/** Renders an hour-of-day bucket key as a wall-clock hour. */
export function hourLabel(key: string): string {
  return `${key}:00`;
}

const WEEKDAY_LABELS: Record<string, string> = {
  '1': 'Пн',
  '2': 'Вт',
  '3': 'Ср',
  '4': 'Чт',
  '5': 'Пт',
  '6': 'Сб',
  '7': 'Вс',
};

/** Renders an ISO weekday bucket key (`1` Monday … `7` Sunday) in Russian. */
export function weekdayLabel(key: string): string {
  return WEEKDAY_LABELS[key] ?? key;
}

export type DrillTarget = 'events' | 'chat' | 'combat-log' | 'external-bans';

/**
 * Builds the drill-down link for a clicked bar, using each destination's own
 * filter parameter names.
 *
 * `/external-bans` parses neither a server nor a date filter today, so its link
 * is deliberately bare instead of carrying parameters the page would ignore.
 *
 * @param target Destination page.
 * @param serverId Server whose bar segment was clicked.
 * @param day `YYYY-MM-DD` for a day-keyed chart, `null` for hour/weekday buckets.
 */
export function drillDownHref(target: DrillTarget, serverId: string, day: string | null): string {
  if (target === 'external-bans') return '/external-bans';
  if (target === 'chat') {
    const dates = day ? `&from=${day}&to=${day}` : '';
    return `/chat?server=${serverId}${dates}`;
  }
  if (target === 'combat-log') {
    const dates = day ? `&preset=custom&from=${day}&to=${day}` : '';
    return `/combat-log?server=${serverId}&facet=teamkills${dates}`;
  }
  const dates = day ? `&preset=custom&from=${day}&to=${day}` : '';
  return `/events?servers=${serverId}${dates}`;
}
