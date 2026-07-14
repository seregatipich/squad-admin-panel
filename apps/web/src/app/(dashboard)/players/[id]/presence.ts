export type SessionMode = 'online' | 'boost' | 'queue' | 'seed';

export interface PresenceSession {
  id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  mode: SessionMode;
  connected_at: string;
  disconnected_at: string | null;
}

export interface PresenceTotals {
  online_seconds: number;
  boost_seconds: number;
  queue_seconds: number;
}

export interface ServerPresence {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  online_seconds: number;
  boost_seconds: number;
  queue_seconds: number;
  session_count: number;
}

export interface PresenceResponse {
  totals: PresenceTotals;
  bonus: { formula: string; value_seconds: number };
  by_server: ServerPresence[];
  sessions: PresenceSession[];
  week: { from: string; to: string };
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_DAYS = 7;

export const BONUS_FORMULA_LABEL = 'online + 2×boost';

export const MODE_LABELS: Record<SessionMode, string> = {
  online: 'Онлайн',
  boost: 'Буст',
  queue: 'Очередь',
  seed: 'Сид',
};

export const MODE_HEX: Record<SessionMode, string> = {
  online: '#10b981',
  boost: '#f59e0b',
  queue: '#38bdf8',
  seed: '#a855f7',
};

export function bonusValueSeconds(totals: PresenceTotals): number {
  return totals.online_seconds + 2 * totals.boost_seconds;
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function weekStartMsForEndDay(endDayKey: string): number {
  const endMidnight = Date.parse(`${endDayKey}T00:00:00.000Z`);
  return endMidnight - (WEEK_DAYS - 1) * DAY_MS;
}

export interface WeekCell {
  dayIndex: number;
  hour: number;
  online_seconds: number;
  boost_seconds: number;
  queue_seconds: number;
  seed_seconds: number;
  total_seconds: number;
  mode: SessionMode | null;
}

export interface WeekGrid {
  days: string[];
  cells: WeekCell[][];
}

function emptyCell(dayIndex: number, hour: number): WeekCell {
  return {
    dayIndex,
    hour,
    online_seconds: 0,
    boost_seconds: 0,
    queue_seconds: 0,
    seed_seconds: 0,
    total_seconds: 0,
    mode: null,
  };
}

function addSeconds(cell: WeekCell, mode: SessionMode, seconds: number): void {
  if (mode === 'boost') cell.boost_seconds += seconds;
  else if (mode === 'queue') cell.queue_seconds += seconds;
  else if (mode === 'seed') cell.seed_seconds += seconds;
  else cell.online_seconds += seconds;
  cell.total_seconds += seconds;
}

export function dominantMode(
  cell: Pick<WeekCell, 'online_seconds' | 'boost_seconds' | 'queue_seconds' | 'seed_seconds'>,
): SessionMode | null {
  const online = cell.online_seconds;
  const boost = cell.boost_seconds;
  const queue = cell.queue_seconds;
  const seed = cell.seed_seconds;
  if (online + boost + queue + seed === 0) return null;
  if (seed > 0 && seed >= online && seed >= boost && seed >= queue) return 'seed';
  if (boost > 0 && boost >= online && boost >= queue) return 'boost';
  if (queue > 0 && queue >= online) return 'queue';
  return 'online';
}

export function buildWeekGrid(
  sessions: PresenceSession[],
  weekStartMs: number,
  nowMs: number,
): WeekGrid {
  const weekEndMs = weekStartMs + WEEK_DAYS * DAY_MS;
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => utcDayKey(weekStartMs + i * DAY_MS));
  const cells: WeekCell[][] = days.map((_, dayIndex) =>
    Array.from({ length: 24 }, (_, hour) => emptyCell(dayIndex, hour)),
  );

  for (const session of sessions) {
    const startMs = Date.parse(session.connected_at);
    const rawEndMs = session.disconnected_at ? Date.parse(session.disconnected_at) : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(rawEndMs)) continue;
    const clampedStart = Math.max(startMs, weekStartMs);
    const clampedEnd = Math.min(rawEndMs, weekEndMs);
    if (clampedEnd <= clampedStart) continue;

    let cursor = Math.floor(clampedStart / HOUR_MS) * HOUR_MS;
    while (cursor < clampedEnd) {
      const bucketStart = Math.max(cursor, clampedStart);
      const bucketEnd = Math.min(cursor + HOUR_MS, clampedEnd);
      const seconds = Math.floor((bucketEnd - bucketStart) / 1000);
      if (seconds > 0) {
        const dayIndex = Math.floor((cursor - weekStartMs) / DAY_MS);
        const hour = Math.floor((cursor % DAY_MS) / HOUR_MS);
        const cell = cells[dayIndex]?.[hour];
        if (cell) addSeconds(cell, session.mode, seconds);
      }
      cursor += HOUR_MS;
    }
  }

  for (const row of cells) {
    for (const cell of row) cell.mode = dominantMode(cell);
  }
  return { days, cells };
}

export function cellFillFraction(cell: WeekCell): number {
  return Math.min(1, cell.total_seconds / 3600);
}

export function cellBackground(cell: WeekCell): string | undefined {
  if (!cell.mode) return undefined;
  const alpha = 0.25 + 0.65 * cellFillFraction(cell);
  return hexWithAlpha(MODE_HEX[cell.mode], alpha);
}

function hexWithAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte}`;
}

export function serverLabel(server: Pick<ServerPresence, 'server_slug' | 'server_name'>): string {
  return server.server_slug ?? server.server_name ?? '—';
}

export function sortServersByOnline(servers: ServerPresence[]): ServerPresence[] {
  return [...servers].sort((a, b) => {
    if (b.online_seconds !== a.online_seconds) return b.online_seconds - a.online_seconds;
    return serverLabel(a).localeCompare(serverLabel(b));
  });
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0м';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м`;
  return `${secs}с`;
}

const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export function dayRowLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return dayKey;
  const weekday = WEEKDAY_LABELS[new Date(ms).getUTCDay()] ?? '';
  return `${weekday} ${dayKey.slice(5)}`;
}

export function cellTitle(cell: WeekCell, dayKey: string): string {
  const hourLabel = `${String(cell.hour).padStart(2, '0')}:00`;
  if (!cell.mode) return `${dayKey} ${hourLabel} — нет активности`;
  return `${dayKey} ${hourLabel} — ${MODE_LABELS[cell.mode]} · ${fmtDuration(cell.total_seconds)}`;
}
