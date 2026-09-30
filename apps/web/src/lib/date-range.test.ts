import { describe, expect, it } from 'vitest';
import { COMMON_DATE_PRESETS, resolveDateRange } from './date-range';

const NOW = new Date(2026, 2, 15, 13, 30, 0, 0);
const none = { from: '', to: '' };

describe('resolveDateRange', () => {
  it('today runs from local midnight to now', () => {
    expect(resolveDateRange({ preset: 'today', ...none }, NOW)).toEqual({
      dateFrom: new Date(2026, 2, 15, 0, 0, 0, 0),
      dateTo: NOW,
    });
  });

  it('yesterday covers the whole previous local day', () => {
    expect(resolveDateRange({ preset: 'yesterday', ...none }, NOW)).toEqual({
      dateFrom: new Date(2026, 2, 14, 0, 0, 0, 0),
      dateTo: new Date(2026, 2, 14, 23, 59, 59, 999),
    });
  });

  it('week starts six days before today midnight', () => {
    expect(resolveDateRange({ preset: 'week', ...none }, NOW).dateFrom).toEqual(
      new Date(2026, 2, 9, 0, 0, 0, 0),
    );
  });

  it('month starts on the first of the current month', () => {
    expect(resolveDateRange({ preset: 'month', ...none }, NOW).dateFrom).toEqual(
      new Date(2026, 2, 1),
    );
  });

  it.each([
    ['24h', 1],
    ['30days', 30],
    ['60days', 60],
    ['90days', 90],
  ] as const)('%s is a rolling window of %i days', (preset, days) => {
    const range = resolveDateRange({ preset, ...none }, NOW);
    expect(range.dateTo).toEqual(NOW);
    expect(range.dateFrom?.getTime()).toBe(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  });

  it('custom resolves day strings to local day bounds', () => {
    expect(
      resolveDateRange({ preset: 'custom', from: '2026-01-02', to: '2026-01-03' }, NOW),
    ).toEqual({
      dateFrom: new Date(2026, 0, 2, 0, 0, 0, 0),
      dateTo: new Date(2026, 0, 3, 23, 59, 59, 999),
    });
  });

  it('custom ignores malformed and non-existent days', () => {
    expect(resolveDateRange({ preset: 'custom', from: '2026-02-31', to: 'abc' }, NOW)).toEqual({});
  });

  it('all is unbounded', () => {
    expect(resolveDateRange({ preset: 'all', ...none }, NOW)).toEqual({});
  });
});

describe('COMMON_DATE_PRESETS', () => {
  it('offers every common preset once with a Russian label', () => {
    expect(COMMON_DATE_PRESETS.map((preset) => preset.value)).toEqual([
      'today',
      'yesterday',
      'week',
      'month',
      '30days',
      'all',
      'custom',
    ]);
  });
});
