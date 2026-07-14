import { describe, expect, it } from 'vitest';
import {
  buildReportsAnalyticsQuery,
  formatAccuracy,
  formatDurationRu,
  formatTrendDay,
  REPORTS_WINDOW_PRESETS,
  reportsWindowRange,
  trendScale,
} from './analytics-data';

describe('buildReportsAnalyticsQuery', () => {
  it('is empty when nothing is set', () => {
    expect(buildReportsAnalyticsQuery({})).toBe('');
  });

  it('encodes server_id, from, to, format', () => {
    const qs = buildReportsAnalyticsQuery({
      serverId: 'srv-1',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-08T00:00:00.000Z',
      format: 'csv',
    });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('server_id')).toBe('srv-1');
    expect(params.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(params.get('to')).toBe('2026-01-08T00:00:00.000Z');
    expect(params.get('format')).toBe('csv');
  });

  it('omits a null/empty server_id', () => {
    const qs = buildReportsAnalyticsQuery({ serverId: null, from: '2026-01-01T00:00:00.000Z' });
    expect(qs).not.toContain('server_id');
  });
});

describe('reportsWindowRange', () => {
  it('derives from/to from a day count', () => {
    const now = new Date('2026-01-08T00:00:00.000Z');
    const range = reportsWindowRange(7, now);
    expect(range.to).toBe(now.toISOString());
    expect(range.from).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('REPORTS_WINDOW_PRESETS', () => {
  it('exposes 7/30/90 day Russian presets', () => {
    expect(REPORTS_WINDOW_PRESETS.map((p) => p.days)).toEqual([7, 30, 90]);
    expect(REPORTS_WINDOW_PRESETS.map((p) => p.label)).toEqual(['7 дней', '30 дней', '90 дней']);
  });
});

describe('formatTrendDay', () => {
  it('formats a YYYY-MM-DD day as DD.MM', () => {
    expect(formatTrendDay('2026-07-09')).toBe('09.07');
  });

  it('falls back to the raw string for invalid input', () => {
    expect(formatTrendDay('not-a-day')).toBe('not-a-day');
  });
});

describe('formatDurationRu', () => {
  it('renders a dash for null/negative/NaN', () => {
    expect(formatDurationRu(null)).toBe('—');
    expect(formatDurationRu(-1)).toBe('—');
    expect(formatDurationRu(Number.NaN)).toBe('—');
  });

  it('renders seconds under a minute', () => {
    expect(formatDurationRu(0)).toBe('0 с');
    expect(formatDurationRu(45)).toBe('45 с');
  });

  it('renders whole minutes without hours', () => {
    expect(formatDurationRu(180)).toBe('3 м');
  });

  it('renders hours and minutes', () => {
    expect(formatDurationRu(8100)).toBe('2 ч 15 м');
  });

  it('renders whole hours without a minutes suffix', () => {
    expect(formatDurationRu(7200)).toBe('2 ч');
  });
});

describe('formatAccuracy', () => {
  it('formats a 0..1 share as a Russian percent', () => {
    expect(formatAccuracy(0)).toBe('0%');
    expect(formatAccuracy(1)).toBe('100%');
    expect(formatAccuracy(0.625)).toBe('62,5%');
  });
});

describe('trendScale', () => {
  it('returns the maximum count, at least 1', () => {
    expect(trendScale([{ count: 1 }, { count: 9 }, { count: 3 }])).toBe(9);
    expect(trendScale([])).toBe(1);
  });
});
