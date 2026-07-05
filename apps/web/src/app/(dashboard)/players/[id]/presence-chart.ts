export type DailyRange = 30 | 90 | 365;

export const DAILY_RANGES: DailyRange[] = [30, 90, 365];

export const DAILY_RANGE_LABELS: Record<DailyRange, string> = {
  30: '30 дней',
  90: '90 дней',
  365: '365 дней',
};

export interface DailyPresencePoint {
  day: string;
  online_seconds: number;
  boost_seconds: number;
  queue_seconds: number;
}

export interface DailyPresenceLive {
  online: boolean;
  since: string | null;
}

export interface DailyPresenceResponse {
  range: DailyRange;
  from: string;
  to: string;
  total_time_played_seconds: number;
  live: DailyPresenceLive;
  series: DailyPresencePoint[];
}

export interface DailyBar {
  day: string;
  online_seconds: number;
  boost_seconds: number;
  queue_seconds: number;
  total_seconds: number;
}

const DAY_MS = 86_400_000;

export function enumerateDays(fromDay: string, toDay: string): string[] {
  const startMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  const endMs = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const days: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

export function buildDailyBars(
  series: DailyPresencePoint[],
  fromDay: string,
  toDay: string,
): DailyBar[] {
  const byDay = new Map(series.map((point) => [point.day, point]));
  return enumerateDays(fromDay, toDay).map((day) => {
    const point = byDay.get(day);
    const online = point?.online_seconds ?? 0;
    const boost = point?.boost_seconds ?? 0;
    const queue = point?.queue_seconds ?? 0;
    return {
      day,
      online_seconds: online,
      boost_seconds: boost,
      queue_seconds: queue,
      total_seconds: online + boost + queue,
    };
  });
}

export function maxTotalSeconds(bars: DailyBar[]): number {
  return bars.reduce((max, bar) => (bar.total_seconds > max ? bar.total_seconds : max), 0);
}

export function niceHourMax(maxSeconds: number): number {
  const hours = maxSeconds / 3600;
  if (hours <= 1) return 1;
  if (hours <= 2) return 2;
  if (hours <= 5) return 5;
  if (hours <= 10) return 10;
  return Math.ceil(hours / 5) * 5;
}

export function liveElapsedLabel(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs);
  const totalSeconds = Math.floor(elapsed / 1000);
  if (totalSeconds < 60) return `уже ${totalSeconds}с`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `уже ${hours}ч ${minutes}м`;
  return `уже ${minutes}м`;
}
