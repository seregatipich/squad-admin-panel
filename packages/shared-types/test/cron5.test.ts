import { describe, expect, it } from 'vitest';
import { cron5Matches, expandCron5Occurrences, isValidCron5, parseCron5 } from '../src/cron5.js';

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
});

describe('cron5Matches', () => {
  it('matches an exact minute/hour on any day', () => {
    const expr = parseCron5('30 14 * * *');
    expect(cron5Matches(expr, new Date('2026-07-11T14:30:00.000Z'))).toBe(true);
    expect(cron5Matches(expr, new Date('2026-07-11T14:31:00.000Z'))).toBe(false);
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
