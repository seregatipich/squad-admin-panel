import { describe, expect, it } from 'vitest';
import {
  buildVotesQuery,
  formatPassRate,
  formatTrendDay,
  formatVoteHour,
  hourScale,
  passRateTone,
  trendScale,
  voteWindowRange,
} from './vote-analytics-data';

describe('formatVoteHour', () => {
  it('zero-pads the hour and appends minutes', () => {
    expect(formatVoteHour(0)).toBe('00:00');
    expect(formatVoteHour(9)).toBe('09:00');
    expect(formatVoteHour(23)).toBe('23:00');
  });
});

describe('formatPassRate', () => {
  it('renders a percent with a comma decimal separator', () => {
    expect(formatPassRate(66.7)).toBe('66,7%');
    expect(formatPassRate(100)).toBe('100%');
    expect(formatPassRate(0)).toBe('0%');
  });
});

describe('passRateTone', () => {
  it('maps rate bands to tone classes', () => {
    expect(passRateTone(80)).toContain('emerald');
    expect(passRateTone(50)).toContain('amber');
    expect(passRateTone(10)).toContain('red');
  });
});

describe('trendScale / hourScale', () => {
  it('returns the maximum count', () => {
    expect(trendScale([{ count: 1 }, { count: 9 }, { count: 3 }])).toBe(9);
    expect(hourScale([{ count: 2 }, { count: 5 }])).toBe(5);
  });

  it('never returns zero so bar heights stay finite', () => {
    expect(trendScale([{ count: 0 }])).toBe(1);
    expect(hourScale([])).toBe(1);
  });
});

describe('formatTrendDay', () => {
  it('formats an ISO day as day/month', () => {
    expect(formatTrendDay('2026-06-01')).toBe('01.06');
  });

  it('passes through an unparsable value', () => {
    expect(formatTrendDay('not-a-date')).toBe('not-a-date');
  });
});

describe('buildVotesQuery', () => {
  it('omits empty params and includes provided filters', () => {
    expect(buildVotesQuery({})).toBe('');
    expect(buildVotesQuery({ serverId: 'abc', format: 'csv' })).toBe('?server_id=abc&format=csv');
  });

  it('encodes the time window', () => {
    const query = buildVotesQuery({ from: '2026-06-01T00:00:00.000Z' });
    expect(query).toContain('from=2026-06-01T00%3A00%3A00.000Z');
  });
});

describe('voteWindowRange', () => {
  it('produces an ISO range spanning the requested days', () => {
    const now = new Date('2026-07-05T12:00:00.000Z');
    const { from, to } = voteWindowRange(30, now);
    expect(to).toBe('2026-07-05T12:00:00.000Z');
    expect(from).toBe('2026-06-05T12:00:00.000Z');
  });
});
