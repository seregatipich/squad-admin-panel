import { describe, expect, it } from 'vitest';
import {
  recentPresenceWindow,
  splitSessionSecondsByUtcDay,
  utcDayKey,
} from '../src/presence/daily.js';

const floorDuration = (start: Date, end: Date) =>
  Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));

describe('splitSessionSecondsByUtcDay', () => {
  it('splits a 23:00-01:00 session into one hour per day', () => {
    const segments = splitSessionSecondsByUtcDay(
      new Date('2026-07-04T23:00:00.000Z'),
      new Date('2026-07-05T01:00:00.000Z'),
    );
    expect(segments).toEqual([
      { day: '2026-07-04', seconds: 3600 },
      { day: '2026-07-05', seconds: 3600 },
    ]);
  });

  it('keeps a single-day session on one day', () => {
    const segments = splitSessionSecondsByUtcDay(
      new Date('2026-07-05T10:00:00.000Z'),
      new Date('2026-07-05T12:30:00.000Z'),
    );
    expect(segments).toEqual([{ day: '2026-07-05', seconds: 9000 }]);
  });

  it('spans three days with the middle day contributing a full 86400 seconds', () => {
    const segments = splitSessionSecondsByUtcDay(
      new Date('2026-07-04T22:00:00.000Z'),
      new Date('2026-07-06T02:00:00.000Z'),
    );
    expect(segments).toEqual([
      { day: '2026-07-04', seconds: 7200 },
      { day: '2026-07-05', seconds: 86400 },
      { day: '2026-07-06', seconds: 7200 },
    ]);
  });

  it('drops a zero-length day when the session ends exactly at midnight', () => {
    const segments = splitSessionSecondsByUtcDay(
      new Date('2026-07-04T23:00:00.000Z'),
      new Date('2026-07-05T00:00:00.000Z'),
    );
    expect(segments).toEqual([{ day: '2026-07-04', seconds: 3600 }]);
  });

  it('returns nothing for a non-positive interval', () => {
    expect(
      splitSessionSecondsByUtcDay(
        new Date('2026-07-05T12:00:00.000Z'),
        new Date('2026-07-05T12:00:00.000Z'),
      ),
    ).toEqual([]);
    expect(
      splitSessionSecondsByUtcDay(
        new Date('2026-07-05T12:00:00.000Z'),
        new Date('2026-07-05T11:00:00.000Z'),
      ),
    ).toEqual([]);
  });

  it('preserves the floored total duration across a sub-second midnight straddle', () => {
    const start = new Date('2026-07-04T23:59:59.500Z');
    const end = new Date('2026-07-05T00:00:00.500Z');
    const segments = splitSessionSecondsByUtcDay(start, end);
    const total = segments.reduce((sum, seg) => sum + seg.seconds, 0);
    expect(total).toBe(floorDuration(start, end));
  });

  it('reconciles per-day seconds with the floored session duration for many offsets', () => {
    const base = Date.parse('2026-07-04T23:59:00.000Z');
    for (let offsetMs = 0; offsetMs < 4000; offsetMs += 137) {
      for (let lengthMs = 1; lengthMs < 5000; lengthMs += 211) {
        const start = new Date(base + offsetMs);
        const end = new Date(base + offsetMs + lengthMs);
        const segments = splitSessionSecondsByUtcDay(start, end);
        const total = segments.reduce((sum, seg) => sum + seg.seconds, 0);
        expect(total).toBe(floorDuration(start, end));
      }
    }
  });
});

describe('recentPresenceWindow / utcDayKey', () => {
  it('returns yesterday and today as UTC day keys', () => {
    const now = new Date('2026-07-05T00:30:00.000Z');
    expect(recentPresenceWindow(now)).toEqual({ fromDay: '2026-07-04', toDay: '2026-07-05' });
  });

  it('derives the UTC calendar date regardless of clock time', () => {
    expect(utcDayKey(new Date('2026-07-05T23:59:59.999Z'))).toBe('2026-07-05');
  });
});
