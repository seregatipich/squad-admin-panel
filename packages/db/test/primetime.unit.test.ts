import { describe, expect, it } from 'vitest';
import {
  bucketSessionsByLocalHour,
  computePlayerPrimetime,
  computePrimetime,
  type PrimetimeSession,
  resolveTimezoneOffsetMinutes,
  rollingAverage,
} from '../src/presence/primetime.js';

const DAY_MS = 86_400_000;

function eveningSessions(
  days: number,
  startHourUtc: number,
  durationHours: number,
): PrimetimeSession[] {
  const sessions: PrimetimeSession[] = [];
  const anchor = Date.parse('2026-07-03T00:00:00.000Z');
  for (let day = 0; day < days; day += 1) {
    const start = anchor - day * DAY_MS + startHourUtc * 3_600_000;
    sessions.push({
      connectedAt: new Date(start),
      disconnectedAt: new Date(start + durationHours * 3_600_000),
    });
  }
  return sessions;
}

describe('resolveTimezoneOffsetMinutes', () => {
  it('returns 0 (UTC) when no timezone is known', () => {
    expect(resolveTimezoneOffsetMinutes(null)).toBe(0);
    expect(resolveTimezoneOffsetMinutes(undefined)).toBe(0);
    expect(resolveTimezoneOffsetMinutes('')).toBe(0);
  });

  it('resolves a DST-free IANA zone to its fixed offset', () => {
    expect(resolveTimezoneOffsetMinutes('Asia/Tokyo', new Date('2026-01-15T00:00:00.000Z'))).toBe(
      540,
    );
    expect(resolveTimezoneOffsetMinutes('UTC', new Date('2026-07-04T00:00:00.000Z'))).toBe(0);
  });

  it('parses a numeric offset string', () => {
    expect(resolveTimezoneOffsetMinutes('+03:00')).toBe(180);
    expect(resolveTimezoneOffsetMinutes('-05:30')).toBe(-330);
    expect(resolveTimezoneOffsetMinutes('UTC+2')).toBe(120);
  });

  it('falls back to UTC for an unparseable timezone', () => {
    expect(resolveTimezoneOffsetMinutes('Totally/Bogus')).toBe(0);
  });
});

describe('bucketSessionsByLocalHour', () => {
  const windowStart = Date.parse('2026-06-04T00:00:00.000Z');
  const windowEnd = Date.parse('2026-07-04T00:00:00.000Z');
  const now = windowEnd;

  it('buckets session minutes into the hours the player was online (UTC)', () => {
    const sessions = eveningSessions(30, 18, 3);
    const histogram = bucketSessionsByLocalHour(sessions, 0, windowStart, windowEnd, now);
    expect(histogram[18]).toBe(30 * 3600);
    expect(histogram[19]).toBe(30 * 3600);
    expect(histogram[20]).toBe(30 * 3600);
    expect(histogram[17]).toBe(0);
    expect(histogram[21]).toBe(0);
    expect(histogram.reduce((sum, seconds) => sum + seconds, 0)).toBe(30 * 3 * 3600);
  });

  it('shifts buckets forward by the timezone offset', () => {
    const sessions = eveningSessions(30, 18, 3);
    const histogram = bucketSessionsByLocalHour(sessions, 180, windowStart, windowEnd, now);
    expect(histogram[21]).toBe(30 * 3600);
    expect(histogram[22]).toBe(30 * 3600);
    expect(histogram[23]).toBe(30 * 3600);
    expect(histogram[18]).toBe(0);
  });

  it('wraps buckets across midnight for a negative offset', () => {
    const sessions = eveningSessions(30, 1, 2);
    const histogram = bucketSessionsByLocalHour(sessions, -180, windowStart, windowEnd, now);
    expect(histogram[22]).toBe(30 * 3600);
    expect(histogram[23]).toBe(30 * 3600);
  });

  it('ignores activity outside the window', () => {
    const sessions: PrimetimeSession[] = [
      {
        connectedAt: new Date(windowStart - 5 * 3_600_000),
        disconnectedAt: new Date(windowStart - 1 * 3_600_000),
      },
    ];
    const histogram = bucketSessionsByLocalHour(sessions, 0, windowStart, windowEnd, now);
    expect(histogram.reduce((sum, seconds) => sum + seconds, 0)).toBe(0);
  });
});

describe('rollingAverage', () => {
  it('smooths circularly with a 3-hour window', () => {
    const histogram = new Array<number>(24).fill(0);
    histogram[12] = 3;
    const smoothed = rollingAverage(histogram);
    expect(smoothed[11]).toBe(1);
    expect(smoothed[12]).toBe(1);
    expect(smoothed[13]).toBe(1);
    expect(smoothed[0]).toBe(0);
  });
});

describe('computePrimetime', () => {
  it('returns no range for an empty histogram', () => {
    expect(computePrimetime(new Array<number>(24).fill(0)).range).toBeNull();
  });

  it('returns no range for uniform activity', () => {
    expect(computePrimetime(new Array<number>(24).fill(1000)).range).toBeNull();
  });

  it('finds the evening contiguous range with minute precision', () => {
    const histogram = new Array<number>(24).fill(0);
    histogram[18] = 30 * 3600;
    histogram[19] = 30 * 3600;
    histogram[20] = 30 * 3600;
    const result = computePrimetime(histogram);
    expect(result.range).not.toBeNull();
    expect(result.range?.startHour).toBe(17);
    expect(result.range?.endHour).toBe(21);
    expect(result.range?.label).toBe('Праймтайм 16:53–22:08');
  });

  it('picks the heavier of two contiguous blocks', () => {
    const histogram = new Array<number>(24).fill(0);
    histogram[8] = 3600;
    histogram[9] = 3600;
    histogram[19] = 5 * 3600;
    histogram[20] = 5 * 3600;
    const result = computePrimetime(histogram);
    expect(result.range?.startHour).toBe(18);
    expect(result.range?.endHour).toBe(21);
  });
});

describe('computePlayerPrimetime', () => {
  const windowStart = Date.parse('2026-06-04T00:00:00.000Z');
  const windowEnd = Date.parse('2026-07-04T00:00:00.000Z');

  it('applies the resolved timezone offset before bucketing', () => {
    const sessions = eveningSessions(30, 18, 3);
    const utc = computePlayerPrimetime({
      sessions,
      timezone: null,
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
      nowMs: windowEnd,
    });
    const shifted = computePlayerPrimetime({
      sessions,
      timezone: '+03:00',
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
      nowMs: windowEnd,
    });
    expect(utc.offsetMinutes).toBe(0);
    expect(utc.histogram[18]).toBe(30 * 3600);
    expect(shifted.offsetMinutes).toBe(180);
    expect(shifted.histogram[21]).toBe(30 * 3600);
    expect(shifted.range?.startHour).toBe(20);
  });
});
