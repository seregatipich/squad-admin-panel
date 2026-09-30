export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatBytesPerSec(bytes: number): string {
  return `${formatBytes(bytes)}/s`;
}

export function formatPercent(used: number, total: number, decimals = 1): string {
  if (!Number.isFinite(total) || total <= 0) return '—';
  const pct = (used / total) * 100;
  return `${pct.toFixed(decimals)}%`;
}

export function ratio(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return used / total;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '< 1m';
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (seconds < hour) {
    const m = Math.floor(seconds / minute);
    return `${m}m`;
  }
  if (seconds < day) {
    const h = Math.floor(seconds / hour);
    const m = Math.floor((seconds - h * hour) / minute);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / day);
  const h = Math.floor((seconds - d * day) / hour);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Server display name: slug, then name, then a dash. */
export function serverLabel(server: {
  server_slug: string | null;
  server_name: string | null;
}): string {
  return server.server_slug ?? server.server_name ?? '—';
}

/** Match duration as `«Xч Yм»`, `«Xм Yс»` or `«Xс»`; a dash for missing or invalid input. */
export function formatMatchDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${secs}с`;
  return `${secs}с`;
}

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converts an `<input type="date">` value into the ISO bound of that day in
 * the browser's time zone — the zone every panel timestamp is rendered in, so
 * a filter "с 01.09" keeps exactly the rows the table labels 01.09 (#462).
 *
 * @param value `YYYY-MM-DD` as produced by a date input; empty means no bound.
 * @param endOfDay `true` for the inclusive upper bound (23:59:59.999 local).
 * @returns The bound as a UTC ISO string, or `null` for an empty/invalid value.
 */
export function dateInputToIso(value: string, endOfDay: boolean): string | null {
  const match = DATE_INPUT_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const bound = endOfDay
    ? new Date(year, month, day, 23, 59, 59, 999)
    : new Date(year, month, day, 0, 0, 0, 0);
  if (Number.isNaN(bound.getTime()) || bound.getMonth() !== month) return null;
  return bound.toISOString();
}

/**
 * The panel's single `ru-RU` date-time format (`09.07.2026, 13:05`), rendered
 * in the browser's zone.
 *
 * @param iso ISO timestamp; `null`, `undefined` or an unparsable value yields `fallback`.
 * @param fallback What to show when there is no valid timestamp; defaults to an em dash.
 */
export function formatDateTimeRu(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats a duration in seconds as Russian "31 мин 05 сек" / "45 сек".
 * Null and non-finite values render "—". Shared by the dashboard and the public stats page.
 */
export function formatDurationRu(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} сек`;
  return `${minutes} мин ${String(rest).padStart(2, '0')} сек`;
}

/** Formats hours with one decimal and a Russian comma, e.g. "12,5 ч". */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${String(rounded).replace('.', ',')} ч`;
}
