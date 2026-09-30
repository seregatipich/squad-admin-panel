import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_WINDOW_PRESETS,
  analyticsWindowRange,
  buildAnalyticsWindowQuery,
  formatTrendDay,
  maxOrOne,
} from './analytics-window';

describe('analytics-window', () => {
  it('offers the 7, 30 and 90 day presets', () => {
    expect(ANALYTICS_WINDOW_PRESETS.map((preset) => preset.days)).toEqual([7, 30, 90]);
  });

  it('builds a query string only from the parameters that are set', () => {
    expect(buildAnalyticsWindowQuery({})).toBe('');
    expect(buildAnalyticsWindowQuery({ serverId: null })).toBe('');
    expect(buildAnalyticsWindowQuery({ serverId: 's1', from: 'a', to: 'b', format: 'csv' })).toBe(
      '?server_id=s1&from=a&to=b&format=csv',
    );
  });

  it('returns the rolling window ending at now', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    expect(analyticsWindowRange(7, now)).toEqual({
      from: '2026-07-03T12:00:00.000Z',
      to: '2026-07-10T12:00:00.000Z',
    });
  });

  it('uses 1 as the divisor of an empty or all-zero series', () => {
    expect(maxOrOne([])).toBe(1);
    expect(maxOrOne([0, 0])).toBe(1);
    expect(maxOrOne([2, 9, 4])).toBe(9);
  });

  it('formats a UTC day without shifting it by the local zone', () => {
    expect(formatTrendDay('2026-07-01')).toBe('01.07');
    expect(formatTrendDay('not-a-day')).toBe('not-a-day');
  });
});
