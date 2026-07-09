import { describe, expect, it } from 'vitest';
import { formatDurationRu, formatHour, formatHours, peakScale } from './stats-data';

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
