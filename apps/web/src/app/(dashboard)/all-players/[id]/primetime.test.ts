import { describe, expect, it } from 'vitest';
import { parsePrimetime, primetimeUrl } from './primetime';

const valid = {
  window: { from: '2026-06-01', to: '2026-06-30', days: 30 },
  timezone: 'Europe/Moscow',
  offset_minutes: 180,
  total_seconds: 7200,
  histogram: Array.from({ length: 24 }, (_, hour) => hour * 10),
  rolling_average: Array.from({ length: 24 }, () => 0),
  primetime: {
    label: '19:00–23:00',
    start_minutes: 1140,
    end_minutes: 1380,
    start_hour: 19,
    end_hour: 22,
  },
};

describe('parsePrimetime', () => {
  it('keeps the fields the section renders from a well-formed body', () => {
    expect(parsePrimetime(valid)).toEqual({
      window: valid.window,
      timezone: 'Europe/Moscow',
      offset_minutes: 180,
      histogram: valid.histogram,
      primetime: { label: '19:00–23:00', start_hour: 19, end_hour: 22 },
    });
  });

  it('accepts an absent primetime and an unset timezone', () => {
    expect(parsePrimetime({ ...valid, primetime: null, timezone: null })).toMatchObject({
      primetime: null,
      timezone: null,
    });
  });

  // Regression (#456): `Math.max(1, ...data.histogram)` threw on a null
  // histogram and took the whole «Присутствие» card down.
  it('rejects a missing, short or non-numeric histogram', () => {
    expect(parsePrimetime({ ...valid, histogram: null })).toBeNull();
    expect(parsePrimetime({ ...valid, histogram: [1, 2, 3] })).toBeNull();
    expect(parsePrimetime({ ...valid, histogram: [...valid.histogram.slice(1), 'x'] })).toBeNull();
  });

  it('rejects a malformed window or primetime range', () => {
    expect(parsePrimetime({ ...valid, window: { days: 'x' } })).toBeNull();
    expect(parsePrimetime({ ...valid, primetime: { label: 1 } })).toBeNull();
    expect(parsePrimetime(null)).toBeNull();
  });
});

describe('primetimeUrl', () => {
  it('encodes the player id', () => {
    expect(primetimeUrl('p/1')).toBe('/api/v1/players/p%2F1/primetime');
  });
});
