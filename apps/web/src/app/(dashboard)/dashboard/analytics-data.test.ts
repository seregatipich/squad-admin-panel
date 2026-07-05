import { describe, expect, it } from 'vitest';
import {
  buildAnalyticsQuery,
  formatDurationRu,
  formatHour,
  formatHours,
  outcomeSegments,
  peakScale,
  windowRange,
  winnerLabelRu,
} from './analytics-data';

describe('formatHour', () => {
  it('zero-pads the hour and appends minutes', () => {
    expect(formatHour(0)).toBe('00:00');
    expect(formatHour(9)).toBe('09:00');
    expect(formatHour(23)).toBe('23:00');
  });
});

describe('peakScale', () => {
  it('returns the maximum peak value', () => {
    expect(peakScale([{ peak_players: 1 }, { peak_players: 5 }, { peak_players: 3 }])).toBe(5);
  });

  it('never returns zero so bar heights stay finite', () => {
    expect(peakScale([{ peak_players: 0 }, { peak_players: 0 }])).toBe(1);
    expect(peakScale([])).toBe(1);
  });
});

describe('outcomeSegments', () => {
  it('computes percentages against the total in fixed category order', () => {
    const segments = outcomeSegments({ team1: 3, team2: 1, draw: 1, unknown: 1, total: 6 });
    expect(segments.map((s) => s.key)).toEqual(['team1', 'team2', 'draw', 'unknown']);
    expect(segments[0]).toMatchObject({ count: 3, percent: 50 });
    expect(segments[1]).toMatchObject({ count: 1, percent: 16.7 });
    expect(segments.find((s) => s.key === 'unknown')?.percent).toBe(16.7);
  });

  it('yields zero percentages when there are no matches', () => {
    const segments = outcomeSegments({ team1: 0, team2: 0, draw: 0, unknown: 0, total: 0 });
    expect(segments.every((s) => s.percent === 0)).toBe(true);
  });
});

describe('winnerLabelRu', () => {
  it('maps outcome keys to Russian labels', () => {
    expect(winnerLabelRu('team1')).toBe('Команда 1');
    expect(winnerLabelRu('draw')).toBe('Ничья');
    expect(winnerLabelRu('unknown')).toBe('Неизвестно');
  });
});

describe('formatDurationRu', () => {
  it('renders minutes and seconds', () => {
    expect(formatDurationRu(1860)).toBe('31 мин 00 сек');
    expect(formatDurationRu(90)).toBe('1 мин 30 сек');
  });

  it('renders seconds-only for sub-minute durations', () => {
    expect(formatDurationRu(45)).toBe('45 сек');
  });

  it('renders a dash for missing durations', () => {
    expect(formatDurationRu(null)).toBe('—');
  });
});

describe('formatHours', () => {
  it('formats hours with the ч suffix', () => {
    expect(formatHours(3.5)).toBe('3,5 ч');
    expect(formatHours(0)).toBe('0 ч');
  });
});

describe('buildAnalyticsQuery', () => {
  it('omits empty params and includes provided filters', () => {
    expect(buildAnalyticsQuery({})).toBe('');
    expect(buildAnalyticsQuery({ serverId: 'abc', format: 'csv' })).toBe(
      '?server_id=abc&format=csv',
    );
  });

  it('encodes the time window', () => {
    const query = buildAnalyticsQuery({ from: '2026-06-01T00:00:00.000Z' });
    expect(query).toContain('from=2026-06-01T00%3A00%3A00.000Z');
  });
});

describe('windowRange', () => {
  it('produces an ISO range spanning the requested days', () => {
    const now = new Date('2026-07-05T12:00:00.000Z');
    const { from, to } = windowRange(7, now);
    expect(to).toBe('2026-07-05T12:00:00.000Z');
    expect(from).toBe('2026-06-28T12:00:00.000Z');
  });
});
