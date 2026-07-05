const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = 1440;
const ROLLING_WINDOW_HOURS = 3;

export interface PrimetimeSession {
  connectedAt: Date;
  disconnectedAt: Date | null;
}

export interface PrimetimeRange {
  startMinutes: number;
  endMinutes: number;
  startHour: number;
  endHour: number;
  label: string;
}

export interface PrimetimeResult {
  histogram: number[];
  rollingAverage: number[];
  totalSeconds: number;
  range: PrimetimeRange | null;
}

const NUMERIC_OFFSET = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;

function parseNumericOffsetMinutes(value: string): number | null {
  const match = NUMERIC_OFFSET.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (hours > 18 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function ianaOffsetMinutes(timezone: string, at: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(at);
    const wall: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== 'literal') wall[part.type] = Number(part.value);
    }
    const year = wall.year ?? 0;
    const month = wall.month ?? 1;
    const day = wall.day ?? 1;
    const hour = (wall.hour ?? 0) === 24 ? 0 : (wall.hour ?? 0);
    const minute = wall.minute ?? 0;
    const second = wall.second ?? 0;
    const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((wallUtcMs - at.getTime()) / MINUTE_MS);
  } catch {
    return null;
  }
}

export function resolveTimezoneOffsetMinutes(
  timezone: string | null | undefined,
  at: Date = new Date(),
): number {
  if (!timezone) return 0;
  const numeric = parseNumericOffsetMinutes(timezone);
  if (numeric !== null) return numeric;
  return ianaOffsetMinutes(timezone, at) ?? 0;
}

export function bucketSessionsByLocalHour(
  sessions: PrimetimeSession[],
  offsetMinutes: number,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
): number[] {
  const buckets = new Array<number>(HOURS_PER_DAY).fill(0);
  const offsetMs = offsetMinutes * MINUTE_MS;

  for (const session of sessions) {
    const startMs = session.connectedAt.getTime();
    const rawEndMs = session.disconnectedAt ? session.disconnectedAt.getTime() : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(rawEndMs)) continue;

    const clampedStart = Math.max(startMs, windowStartMs);
    const clampedEnd = Math.min(rawEndMs, windowEndMs);
    if (clampedEnd <= clampedStart) continue;

    const localStart = clampedStart + offsetMs;
    const localEnd = clampedEnd + offsetMs;

    let cursor = Math.floor(localStart / HOUR_MS) * HOUR_MS;
    while (cursor < localEnd) {
      const bucketStart = Math.max(cursor, localStart);
      const bucketEnd = Math.min(cursor + HOUR_MS, localEnd);
      const seconds = Math.floor((bucketEnd - bucketStart) / 1000);
      if (seconds > 0) {
        const hour = Math.floor((((cursor % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
        buckets[hour] = (buckets[hour] ?? 0) + seconds;
      }
      cursor += HOUR_MS;
    }
  }

  return buckets;
}

export function rollingAverage(histogram: number[], window = ROLLING_WINDOW_HOURS): number[] {
  const length = histogram.length;
  const half = Math.floor(window / 2);
  const smoothed = new Array<number>(length).fill(0);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      sum += histogram[(((index + offset) % length) + length) % length] ?? 0;
    }
    smoothed[index] = sum / window;
  }
  return smoothed;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface ActiveRun {
  startHour: number;
  endHour: number;
  weight: number;
}

function bestActiveRun(active: boolean[], weights: number[]): ActiveRun | null {
  const length = active.length;
  const activeCount = active.reduce((count, flag) => count + (flag ? 1 : 0), 0);
  if (activeCount === 0 || activeCount === length) return null;

  const scanStart = active.indexOf(false);
  let best: ActiveRun | null = null;
  let cursor = 0;
  while (cursor < length) {
    const hour = (scanStart + cursor) % length;
    if (!active[hour]) {
      cursor += 1;
      continue;
    }
    const runStart = hour;
    let weight = 0;
    let runEnd = hour;
    while (cursor < length && active[(scanStart + cursor) % length]) {
      const runHour = (scanStart + cursor) % length;
      weight += weights[runHour] ?? 0;
      runEnd = runHour;
      cursor += 1;
    }
    if (!best || weight > best.weight) {
      best = { startHour: runStart, endHour: runEnd, weight };
    }
  }
  return best;
}

function interpolateStartHours(startHour: number, smoothed: number[], baseline: number): number {
  const previous = smoothed[(startHour - 1 + HOURS_PER_DAY) % HOURS_PER_DAY] ?? 0;
  const current = smoothed[startHour] ?? 0;
  if (current <= previous) return startHour;
  const fraction = clamp01((baseline - previous) / (current - previous));
  return startHour - 0.5 + fraction;
}

function interpolateEndHours(endHour: number, smoothed: number[], baseline: number): number {
  const current = smoothed[endHour] ?? 0;
  const next = smoothed[(endHour + 1) % HOURS_PER_DAY] ?? 0;
  if (current <= next) return endHour + 1;
  const fraction = clamp01((current - baseline) / (current - next));
  return endHour + 0.5 + fraction;
}

function hoursToMinutesOfDay(hours: number): number {
  const raw = Math.round(hours * 60);
  return ((raw % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function formatHourMinute(minutesOfDay: number): string {
  const hour = Math.floor(minutesOfDay / 60) % HOURS_PER_DAY;
  const minute = minutesOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function computePrimetime(histogram: number[]): PrimetimeResult {
  const smoothed = rollingAverage(histogram);
  const totalSeconds = histogram.reduce((sum, seconds) => sum + seconds, 0);

  if (totalSeconds <= 0) {
    return { histogram, rollingAverage: smoothed, totalSeconds, range: null };
  }

  const baseline = totalSeconds / HOURS_PER_DAY;
  const active = smoothed.map((value) => value >= baseline);
  const run = bestActiveRun(active, histogram);
  if (!run) {
    return { histogram, rollingAverage: smoothed, totalSeconds, range: null };
  }

  const startHours = interpolateStartHours(run.startHour, smoothed, baseline);
  const endHours = interpolateEndHours(run.endHour, smoothed, baseline);
  const startMinutes = hoursToMinutesOfDay(startHours);
  const endMinutes = hoursToMinutesOfDay(endHours);

  return {
    histogram,
    rollingAverage: smoothed,
    totalSeconds,
    range: {
      startMinutes,
      endMinutes,
      startHour: run.startHour,
      endHour: run.endHour,
      label: `Праймтайм ${formatHourMinute(startMinutes)}–${formatHourMinute(endMinutes)}`,
    },
  };
}

export interface PlayerPrimetimeInput {
  sessions: PrimetimeSession[];
  timezone: string | null | undefined;
  windowStartMs: number;
  windowEndMs: number;
  nowMs: number;
}

export interface PlayerPrimetimeResult extends PrimetimeResult {
  offsetMinutes: number;
}

export function computePlayerPrimetime(input: PlayerPrimetimeInput): PlayerPrimetimeResult {
  const offsetMinutes = resolveTimezoneOffsetMinutes(input.timezone, new Date(input.windowEndMs));
  const histogram = bucketSessionsByLocalHour(
    input.sessions,
    offsetMinutes,
    input.windowStartMs,
    input.windowEndMs,
    input.nowMs,
  );
  return { ...computePrimetime(histogram), offsetMinutes };
}
