import { isArrayOf, isFiniteNumber, isNullableString, isRecord } from '@/lib/json-guards';

/** The peak range as the section renders it: a label plus its hour bounds. */
export interface PrimetimeRange {
  label: string;
  start_hour: number;
  end_hour: number;
}

/**
 * The part of `GET /api/v1/players/:id/primetime` the section renders. The
 * API also sends `total_seconds`, `rolling_average` and the minute bounds of
 * the range; the card does not draw them, so they are not read.
 */
export interface PrimetimeResponse {
  window: { from: string; to: string; days: number };
  timezone: string | null;
  offset_minutes: number;
  /** Seconds played per hour of the day, exactly 24 entries. */
  histogram: number[];
  primetime: PrimetimeRange | null;
}

export function primetimeUrl(playerId: string): string {
  return `/api/v1/players/${encodeURIComponent(playerId)}/primetime`;
}

function parseRange(value: unknown): PrimetimeRange | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.label !== 'string' ||
    !isFiniteNumber(value.start_hour) ||
    !isFiniteNumber(value.end_hour)
  ) {
    return undefined;
  }
  return { label: value.label, start_hour: value.start_hour, end_hour: value.end_hour };
}

/**
 * Validates a decoded primetime body, returning `null` on any shape mismatch
 * so a drifted response renders as an error instead of throwing inside
 * `Math.max(...histogram)` and taking the «Присутствие» card down (#456).
 */
export function parsePrimetime(json: unknown): PrimetimeResponse | null {
  if (!isRecord(json)) return null;
  const { window, timezone, offset_minutes: offsetMinutes, histogram } = json;
  if (
    !isRecord(window) ||
    typeof window.from !== 'string' ||
    typeof window.to !== 'string' ||
    !isFiniteNumber(window.days)
  ) {
    return null;
  }
  if (!isNullableString(timezone) || !isFiniteNumber(offsetMinutes)) return null;
  if (!isArrayOf(histogram, isFiniteNumber) || histogram.length !== 24) return null;
  const primetime = parseRange(json.primetime);
  if (primetime === undefined) return null;
  return {
    window: { from: window.from, to: window.to, days: window.days },
    timezone,
    offset_minutes: offsetMinutes,
    histogram,
    primetime,
  };
}
