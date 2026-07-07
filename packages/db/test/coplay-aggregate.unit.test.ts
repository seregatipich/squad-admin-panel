import { describe, expect, it } from 'vitest';
import { coplayOverlapByDay } from '../src/coplay/aggregate.js';

function session(connectedAt: string, endAt: string) {
  return { connectedAt: new Date(connectedAt), endAt: new Date(endAt) };
}

function total(segments: { seconds: number }[]): number {
  return segments.reduce((sum, s) => sum + s.seconds, 0);
}

describe('coplayOverlapByDay', () => {
  it('returns the clipped intersection of two overlapping sessions', () => {
    // a: 10:00-12:00, b: 11:00-13:00 -> overlap 11:00-12:00 = 3600s
    const segments = coplayOverlapByDay(
      session('2026-07-05T10:00:00.000Z', '2026-07-05T12:00:00.000Z'),
      session('2026-07-05T11:00:00.000Z', '2026-07-05T13:00:00.000Z'),
    );
    expect(segments).toEqual([{ day: '2026-07-05', seconds: 3600 }]);
  });

  it('is symmetric in its two arguments', () => {
    const a = session('2026-07-05T10:00:00.000Z', '2026-07-05T12:00:00.000Z');
    const b = session('2026-07-05T11:30:00.000Z', '2026-07-05T14:00:00.000Z');
    expect(coplayOverlapByDay(a, b)).toEqual(coplayOverlapByDay(b, a));
  });

  it('returns an empty array when the sessions never overlap', () => {
    const segments = coplayOverlapByDay(
      session('2026-07-05T10:00:00.000Z', '2026-07-05T11:00:00.000Z'),
      session('2026-07-05T11:00:00.000Z', '2026-07-05T12:00:00.000Z'),
    );
    expect(segments).toEqual([]);
  });

  it('splits a cross-midnight overlap across two UTC days', () => {
    // both online 23:00-01:00 -> 3600s on each day
    const segments = coplayOverlapByDay(
      session('2026-07-04T23:00:00.000Z', '2026-07-05T01:00:00.000Z'),
      session('2026-07-04T22:30:00.000Z', '2026-07-05T02:00:00.000Z'),
    );
    expect(segments).toEqual([
      { day: '2026-07-04', seconds: 3600 },
      { day: '2026-07-05', seconds: 3600 },
    ]);
    expect(total(segments)).toBe(7200);
  });

  it('clips the overlap to the shorter of the two sessions', () => {
    // a fully inside b -> overlap == a's duration = 1800s
    const segments = coplayOverlapByDay(
      session('2026-07-05T12:00:00.000Z', '2026-07-05T12:30:00.000Z'),
      session('2026-07-05T10:00:00.000Z', '2026-07-05T15:00:00.000Z'),
    );
    expect(total(segments)).toBe(1800);
  });
});
