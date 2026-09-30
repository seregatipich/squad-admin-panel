import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ 'x-forwarded-for': '198.51.100.4' })),
}));

import { formatDurationRu, formatHour, formatHours, getPublicStats, peakScale } from './stats-data';

afterEach(() => vi.unstubAllGlobals());

// #755: the SSR fetch must carry the visitor's IP so the API rate limit is per visitor.
describe('getPublicStats', () => {
  it('forwards the visitor IP from the incoming request', async () => {
    const fn = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fn);
    await getPublicStats();
    const init = fn.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-forwarded-for')).toBe('198.51.100.4');
  });
});

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

describe('formatDurationRu', () => {
  it('renders minutes and seconds', () => {
    expect(formatDurationRu(1860)).toBe('31 мин 00 сек');
    expect(formatDurationRu(90)).toBe('1 мин 30 сек');
  });

  it('renders seconds only when under a minute', () => {
    expect(formatDurationRu(45)).toBe('45 сек');
  });

  it('renders a dash for null or non-finite values', () => {
    expect(formatDurationRu(null)).toBe('—');
    expect(formatDurationRu(Number.NaN)).toBe('—');
  });
});

describe('formatHours', () => {
  it('rounds to one decimal with a comma separator', () => {
    expect(formatHours(3.456)).toBe('3,5 ч');
    expect(formatHours(0)).toBe('0 ч');
  });
});
