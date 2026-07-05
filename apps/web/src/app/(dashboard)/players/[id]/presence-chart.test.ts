import { describe, expect, it } from 'vitest';
import {
  buildDailyBars,
  type DailyPresencePoint,
  enumerateDays,
  liveElapsedLabel,
  maxTotalSeconds,
  niceHourMax,
} from './presence-chart';

function point(overrides: Partial<DailyPresencePoint> = {}): DailyPresencePoint {
  return {
    day: '2026-07-03',
    online_seconds: 3600,
    boost_seconds: 0,
    queue_seconds: 0,
    ...overrides,
  };
}

describe('enumerateDays', () => {
  it('produces an inclusive dense UTC day range', () => {
    expect(enumerateDays('2026-07-01', '2026-07-04')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
    ]);
  });

  it('crosses month and year boundaries', () => {
    expect(enumerateDays('2025-12-31', '2026-01-02')).toEqual([
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
  });

  it('returns a single day when from equals to', () => {
    expect(enumerateDays('2026-07-05', '2026-07-05')).toEqual(['2026-07-05']);
  });

  it('returns empty when the range is inverted or malformed', () => {
    expect(enumerateDays('2026-07-05', '2026-07-01')).toEqual([]);
    expect(enumerateDays('bad', '2026-07-01')).toEqual([]);
  });
});

describe('buildDailyBars', () => {
  it('fills missing days with zeros and totals each bar', () => {
    const bars = buildDailyBars(
      [point({ day: '2026-07-02', online_seconds: 3600, boost_seconds: 1800, queue_seconds: 600 })],
      '2026-07-01',
      '2026-07-03',
    );
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ day: '2026-07-01', total_seconds: 0 });
    expect(bars[1]).toMatchObject({
      day: '2026-07-02',
      online_seconds: 3600,
      boost_seconds: 1800,
      queue_seconds: 600,
      total_seconds: 6000,
    });
    expect(bars[2]).toMatchObject({ day: '2026-07-03', total_seconds: 0 });
  });
});

describe('maxTotalSeconds', () => {
  it('returns the largest bar total', () => {
    const bars = buildDailyBars(
      [
        point({ day: '2026-07-01', online_seconds: 3600 }),
        point({ day: '2026-07-02', online_seconds: 10_800 }),
      ],
      '2026-07-01',
      '2026-07-02',
    );
    expect(maxTotalSeconds(bars)).toBe(10_800);
  });

  it('returns 0 for an empty range', () => {
    expect(maxTotalSeconds([])).toBe(0);
  });
});

describe('niceHourMax', () => {
  it('never rounds below one hour', () => {
    expect(niceHourMax(0)).toBe(1);
    expect(niceHourMax(1800)).toBe(1);
  });

  it('snaps to friendly axis ceilings', () => {
    expect(niceHourMax(3 * 3600)).toBe(5);
    expect(niceHourMax(7 * 3600)).toBe(10);
    expect(niceHourMax(13 * 3600)).toBe(15);
  });
});

describe('liveElapsedLabel', () => {
  it('shows seconds under a minute', () => {
    expect(liveElapsedLabel(0, 45_000)).toBe('уже 45с');
  });

  it('shows minutes under an hour', () => {
    expect(liveElapsedLabel(0, 15 * 60_000)).toBe('уже 15м');
  });

  it('shows hours and minutes past an hour', () => {
    expect(liveElapsedLabel(0, (2 * 3600 + 15 * 60) * 1000)).toBe('уже 2ч 15м');
  });

  it('never returns a negative elapsed time', () => {
    expect(liveElapsedLabel(1000, 0)).toBe('уже 0с');
  });
});
