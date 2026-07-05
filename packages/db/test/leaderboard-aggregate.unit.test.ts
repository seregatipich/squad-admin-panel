import { describe, expect, it } from 'vitest';
import {
  computeKdRatio,
  isoWeekStart,
  monthStart,
  periodDayRange,
  periodStartFor,
  periodsToRecompute,
  rollupServers,
} from '../src/leaderboard/aggregate.js';

describe('computeKdRatio', () => {
  it('returns kills when deaths is zero', () => {
    expect(computeKdRatio(5, 0)).toBe(5);
    expect(computeKdRatio(0, 0)).toBe(0);
  });

  it('divides kills by deaths otherwise', () => {
    expect(computeKdRatio(10, 4)).toBe(2.5);
    expect(computeKdRatio(3, 6)).toBe(0.5);
  });
});

describe('rollupServers', () => {
  it('sums metrics across servers and recomputes kd from the totals', () => {
    const rolled = rollupServers([
      {
        onlineSeconds: 100,
        seedingSeconds: 10,
        kills: 6,
        deaths: 2,
        teamkills: 1,
        revives: 3,
        matchesPlayed: 2,
      },
      {
        onlineSeconds: 200,
        seedingSeconds: 20,
        kills: 4,
        deaths: 2,
        teamkills: 0,
        revives: 1,
        matchesPlayed: 3,
      },
    ]);

    expect(rolled.onlineSeconds).toBe(300);
    expect(rolled.seedingSeconds).toBe(30);
    expect(rolled.kills).toBe(10);
    expect(rolled.deaths).toBe(4);
    expect(rolled.matchesPlayed).toBe(5);
    expect(rolled.kdRatio).toBe(2.5);
  });

  it('recomputes kd rather than averaging per-server ratios', () => {
    const rolled = rollupServers([
      {
        onlineSeconds: 0,
        seedingSeconds: 0,
        kills: 10,
        deaths: 0,
        teamkills: 0,
        revives: 0,
        matchesPlayed: 0,
      },
      {
        onlineSeconds: 0,
        seedingSeconds: 0,
        kills: 0,
        deaths: 5,
        teamkills: 0,
        revives: 0,
        matchesPlayed: 0,
      },
    ]);
    expect(rolled.kdRatio).toBe(2);
  });

  it('returns zeroed metrics for an empty server list', () => {
    const rolled = rollupServers([]);
    expect(rolled.onlineSeconds).toBe(0);
    expect(rolled.kdRatio).toBe(0);
  });
});

describe('period start derivation', () => {
  it('anchors the week to the ISO Monday in UTC', () => {
    expect(isoWeekStart('2026-07-05')).toBe('2026-06-29');
    expect(isoWeekStart('2026-06-29')).toBe('2026-06-29');
    expect(isoWeekStart('2026-07-06')).toBe('2026-07-06');
  });

  it('anchors the month to the first day', () => {
    expect(monthStart('2026-07-05')).toBe('2026-07-01');
    expect(monthStart('2026-02-28')).toBe('2026-02-01');
  });

  it('maps period types to their period_start', () => {
    expect(periodStartFor('day', '2026-07-05')).toBe('2026-07-05');
    expect(periodStartFor('week', '2026-07-05')).toBe('2026-06-29');
    expect(periodStartFor('month', '2026-07-05')).toBe('2026-07-01');
    expect(periodStartFor('alltime', '2026-07-05')).toBe('1970-01-01');
  });

  it('throws for period types with no derivable start', () => {
    expect(() => periodStartFor('season', '2026-07-05')).toThrow();
  });
});

describe('periodDayRange', () => {
  it('covers a single day for the day period', () => {
    expect(periodDayRange('day', '2026-07-05')).toEqual({
      fromDay: '2026-07-05',
      toDay: '2026-07-05',
    });
  });

  it('covers Monday..Sunday for the week period', () => {
    expect(periodDayRange('week', '2026-06-29')).toEqual({
      fromDay: '2026-06-29',
      toDay: '2026-07-05',
    });
  });

  it('covers the whole calendar month', () => {
    expect(periodDayRange('month', '2026-07-01')).toEqual({
      fromDay: '2026-07-01',
      toDay: '2026-07-31',
    });
    expect(periodDayRange('month', '2026-02-01')).toEqual({
      fromDay: '2026-02-01',
      toDay: '2026-02-28',
    });
    expect(periodDayRange('month', '2024-02-01')).toEqual({
      fromDay: '2024-02-01',
      toDay: '2024-02-29',
    });
  });

  it('returns null for unbounded periods', () => {
    expect(periodDayRange('alltime', '1970-01-01')).toBeNull();
    expect(periodDayRange('season', '2026-07-01')).toBeNull();
  });
});

describe('periodsToRecompute', () => {
  it('yields current and previous day/week/month plus alltime, de-duplicated', () => {
    const periods = periodsToRecompute(new Date('2026-07-05T12:00:00.000Z'));
    expect(periods).toContainEqual({ periodType: 'day', periodStart: '2026-07-05' });
    expect(periods).toContainEqual({ periodType: 'day', periodStart: '2026-07-04' });
    expect(periods).toContainEqual({ periodType: 'week', periodStart: '2026-06-29' });
    expect(periods).toContainEqual({ periodType: 'month', periodStart: '2026-07-01' });
    expect(periods).toContainEqual({ periodType: 'alltime', periodStart: '1970-01-01' });

    const keys = periods.map((p) => `${p.periodType}:${p.periodStart}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
