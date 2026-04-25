import { describe, expect, it } from 'vitest';
import { liveTone } from './LiveIndicator';

describe('liveTone', () => {
  it('returns neutral for null age', () => {
    expect(liveTone(null)).toBe('neutral');
  });

  it('returns neutral for NaN', () => {
    expect(liveTone(Number.NaN)).toBe('neutral');
  });

  it('returns neutral for negative ages', () => {
    expect(liveTone(-1)).toBe('neutral');
  });

  it('returns emerald just under 10s', () => {
    expect(liveTone(0)).toBe('emerald');
    expect(liveTone(9_999)).toBe('emerald');
  });

  it('flips to amber at exactly 10s', () => {
    expect(liveTone(10_000)).toBe('amber');
  });

  it('returns amber just under 60s', () => {
    expect(liveTone(59_999)).toBe('amber');
  });

  it('flips to red at exactly 60s', () => {
    expect(liveTone(60_000)).toBe('red');
  });

  it('returns red for very old ages', () => {
    expect(liveTone(5 * 60_000)).toBe('red');
  });
});
