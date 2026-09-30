import { describe, expect, it } from 'vitest';
import {
  cron5Matches,
  expandCron5Occurrences,
  findLastCron5Occurrence,
  isValidCron5,
  minCron5IntervalMinutes,
  parseCron5,
} from '../src/cron5.js';

describe('parseCron5 / isValidCron5', () => {
  it('parses a well-formed 5-field expression', () => {
    const expr = parseCron5('0 10 * * 6');
    expect(expr).toEqual({
      minute: [0],
      hour: [10],
      dayOfMonth: null,
      month: null,
      dayOfWeek: [6],
    });
  });

  it('parses comma lists and step expressions', () => {
    const expr = parseCron5('0,30 */6 1,15 * *');
    expect(expr.minute).toEqual([0, 30]);
    expect(expr.hour).toEqual([0, 6, 12, 18]);
    expect(expr.dayOfMonth).toEqual([1, 15]);

    const numericStart = parseCron5('* * 5/10 * *');
    expect(numericStart.dayOfMonth).toEqual([5, 15, 25]);
  });

  it('rejects an expression without exactly 5 fields', () => {
    expect(isValidCron5('* * * *')).toBe(false);
    expect(isValidCron5('* * * * * *')).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(isValidCron5('60 * * * *')).toBe(false);
    expect(isValidCron5('* 24 * * *')).toBe(false);
    expect(isValidCron5('* * 32 * *')).toBe(false);
    expect(isValidCron5('* * * 13 *')).toBe(false);
    expect(isValidCron5('* * * * 7')).toBe(false);
  });

  it('rejects ranges and non-standard extensions', () => {
    expect(isValidCron5('0 1-5 * * *')).toBe(false);
    expect(isValidCron5('0 0 * * 6L')).toBe(false);
  });

  it('accepts a valid expression', () => {
    expect(isValidCron5('*/2 * * * *')).toBe(true);
  });

  it('rejects a step expression with a non-positive step', () => {
    expect(isValidCron5('*/0 * * * *')).toBe(false);
  });
});

describe('cron5Matches', () => {
  it('matches an exact minute/hour on any day', () => {
    const expr = parseCron5('30 14 * * *');
    expect(cron5Matches(expr, new Date('2026-07-11T14:30:00.000Z'))).toBe(true);
    expect(cron5Matches(expr, new Date('2026-07-11T14:31:00.000Z'))).toBe(false);
  });

  it('matches only within a restricted month', () => {
    const expr = parseCron5('30 14 * 7 *');
    expect(cron5Matches(expr, new Date('2026-07-11T14:30:00.000Z'))).toBe(true);
    expect(cron5Matches(expr, new Date('2026-06-11T14:30:00.000Z'))).toBe(false);
  });

  it('matches weekly on the configured day-of-week', () => {
    // 2026-07-11 is a Saturday (day 6).
    const expr = parseCron5('0 10 * * 6');
    expect(cron5Matches(expr, new Date('2026-07-11T10:00:00.000Z'))).toBe(true);
    expect(cron5Matches(expr, new Date('2026-07-12T10:00:00.000Z'))).toBe(false);
  });

  it('ORs day-of-month and day-of-week when both are restricted', () => {
    const expr = parseCron5('0 0 1 * 6');
    // 2026-07-01 is a Wednesday: matches via day-of-month.
    expect(cron5Matches(expr, new Date('2026-07-01T00:00:00.000Z'))).toBe(true);
    // 2026-07-11 is a Saturday: matches via day-of-week.
    expect(cron5Matches(expr, new Date('2026-07-11T00:00:00.000Z'))).toBe(true);
    // Neither day-of-month nor day-of-week matches.
    expect(cron5Matches(expr, new Date('2026-07-02T00:00:00.000Z'))).toBe(false);
  });

  it('rejects a day outside a day-of-month-only expression', () => {
    const expr = parseCron5('0 0 1 * *');
    expect(cron5Matches(expr, new Date('2026-07-02T00:00:00.000Z'))).toBe(false);
  });

  it('treats malformed undefined day fields as a non-match', () => {
    const expr = {
      minute: null,
      hour: null,
      dayOfMonth: undefined as unknown as readonly number[],
      month: null,
      dayOfWeek: undefined as unknown as readonly number[],
    } as Parameters<typeof cron5Matches>[0];
    expect(cron5Matches(expr, new Date('2026-07-02T00:00:00.000Z'))).toBe(false);
  });
});

describe('expandCron5Occurrences', () => {
  it('expands every Saturday 10:00 within a two-week range', () => {
    const occurrences = expandCron5Occurrences(
      '0 10 * * 6',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-14T23:59:00.000Z'),
    );
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      '2026-07-04T10:00:00.000Z',
      '2026-07-11T10:00:00.000Z',
    ]);
  });

  it('returns an empty array when the range contains no occurrence', () => {
    const occurrences = expandCron5Occurrences(
      '0 10 * * 6',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-02T00:00:00.000Z'),
    );
    expect(occurrences).toEqual([]);
  });
});

describe('findLastCron5Occurrence', () => {
  it('finds a quarterly occurrence more than 40 days behind `now` (#1014)', () => {
    // Quarterly on the 1st of Jan/Apr/Jul/Oct; created 2026-02-05, "now" is
    // 2026-09-28 — the cursor is ~235 days behind, well past the old 40-day
    // minute-expansion cap. The most recent occurrence is 2026-07-01.
    const occurrence = findLastCron5Occurrence(
      '0 0 1 1,4,7,10 *',
      new Date('2026-02-05T00:00:00.000Z'),
      new Date('2026-09-28T00:00:00.000Z'),
    );
    expect(occurrence?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('finds an annual occurrence after a full year of downtime', () => {
    const occurrence = findLastCron5Occurrence(
      '0 0 1 1 *',
      new Date('2025-01-02T00:00:00.000Z'),
      new Date('2026-09-28T00:00:00.000Z'),
    );
    expect(occurrence?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('collapses multiple missed daily occurrences after a long pause to the single latest one', () => {
    // A daily 00:00 task paused for 100 days must fire exactly once, at the
    // most recent midnight, not replay every missed day.
    const occurrence = findLastCron5Occurrence(
      '0 0 * * *',
      new Date('2026-06-20T00:00:01.000Z'),
      new Date('2026-09-28T12:00:00.000Z'),
    );
    expect(occurrence?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('returns null when the range contains no occurrence', () => {
    const occurrence = findLastCron5Occurrence(
      '0 10 * * 6',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-02T00:00:00.000Z'),
    );
    expect(occurrence).toBeNull();
  });

  it('returns null when `from` is after `to`', () => {
    const occurrence = findLastCron5Occurrence(
      '0 10 * * 6',
      new Date('2026-07-14T00:00:00.000Z'),
      new Date('2026-07-01T00:00:00.000Z'),
    );
    expect(occurrence).toBeNull();
  });

  it('matches either day field when both day-of-month and day-of-week are restricted', () => {
    // 2026-07-01 is a Wednesday (day-of-month hit), 2026-07-04 a Saturday (day-of-week hit).
    const from = new Date('2026-06-30T00:00:00.000Z');
    expect(
      findLastCron5Occurrence(
        '0 10 1 * 6',
        from,
        new Date('2026-07-03T00:00:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-07-01T10:00:00.000Z');
    expect(
      findLastCron5Occurrence(
        '0 10 1 * 6',
        from,
        new Date('2026-07-05T00:00:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-07-04T10:00:00.000Z');
  });

  it('honours a day-of-week only restriction', () => {
    const occurrence = findLastCron5Occurrence(
      '0 10 * * 6',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-14T23:59:00.000Z'),
    );
    expect(occurrence?.toISOString()).toBe('2026-07-11T10:00:00.000Z');
  });

  it('skips a candidate before `from` on the first day, then finds none', () => {
    const occurrence = findLastCron5Occurrence(
      '0 10 * * *',
      new Date('2026-07-11T10:30:00.000Z'),
      new Date('2026-07-11T12:00:00.000Z'),
    );
    expect(occurrence).toBeNull();
  });

  it('skips candidates after `to` on the last day and returns the latest one inside the window', () => {
    const occurrence = findLastCron5Occurrence(
      '0 10,12 * * *',
      new Date('2026-07-11T09:00:00.000Z'),
      new Date('2026-07-11T11:00:00.000Z'),
    );
    expect(occurrence?.toISOString()).toBe('2026-07-11T10:00:00.000Z');
  });

  it('scans every minute of a wildcard hour and every hour of a wildcard minute', () => {
    const to = new Date('2026-07-11T15:45:30.000Z');
    const from = new Date('2026-07-11T00:00:00.000Z');
    expect(findLastCron5Occurrence('30 * * * *', from, to)?.toISOString()).toBe(
      '2026-07-11T15:30:00.000Z',
    );
    expect(findLastCron5Occurrence('* 10 * * *', from, to)?.toISOString()).toBe(
      '2026-07-11T10:59:00.000Z',
    );
  });

  it('agrees with expandCron5Occurrences on the latest match for a short window', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-07-14T23:59:00.000Z');
    const expanded = expandCron5Occurrences('0 10 * * 6', from, to);
    const last = findLastCron5Occurrence('0 10 * * 6', from, to);
    expect(last?.toISOString()).toBe(expanded.at(-1)?.toISOString());
  });
});

describe('minCron5IntervalMinutes', () => {
  it('returns the minute step for a sub-hourly step expression', () => {
    expect(minCron5IntervalMinutes('*/1 * * * *')).toBe(1);
    expect(minCron5IntervalMinutes('*/5 * * * *')).toBe(5);
    expect(minCron5IntervalMinutes('*/30 * * * *')).toBe(30);
  });

  it('returns 60 for an hourly expression', () => {
    expect(minCron5IntervalMinutes('0 * * * *')).toBe(60);
  });

  it('returns the weekly gap (10080 minutes) for a once-a-week expression', () => {
    expect(minCron5IntervalMinutes('0 10 * * 6')).toBe(10080);
  });

  it('returns the smallest gap when a day has two close occurrences', () => {
    expect(minCron5IntervalMinutes('0,1 10 * * *')).toBe(1);
  });

  it('returns Infinity when fewer than two occurrences fall in the probe window', () => {
    // 00:00 on the 1st of the month: only 2024-12-01 lands in the December
    // probe window, so there is no consecutive pair to measure.
    expect(minCron5IntervalMinutes('0 0 1 * *')).toBe(Number.POSITIVE_INFINITY);
  });

  it('throws on a malformed expression', () => {
    expect(() => minCron5IntervalMinutes('not a cron')).toThrow();
  });
});
