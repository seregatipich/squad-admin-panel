import { describe, expect, it } from 'vitest';
import { jitteredBackoffMs, nextBackoffMs } from './ws-backoff';

describe('nextBackoffMs', () => {
  it('returns 1000 ms on the first attempt', () => {
    expect(nextBackoffMs(0)).toBe(1000);
  });

  it('doubles to 2000 ms on the second attempt', () => {
    expect(nextBackoffMs(1)).toBe(2000);
  });

  it('reaches 4000 ms on the third attempt', () => {
    expect(nextBackoffMs(2)).toBe(4000);
  });

  it('reaches 8000 ms on the fourth attempt', () => {
    expect(nextBackoffMs(3)).toBe(8000);
  });

  it('reaches 16000 ms on the fifth attempt', () => {
    expect(nextBackoffMs(4)).toBe(16000);
  });

  it('caps at 30000 ms from the sixth attempt onward', () => {
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(6)).toBe(30000);
    expect(nextBackoffMs(20)).toBe(30000);
    expect(nextBackoffMs(1000)).toBe(30000);
  });

  it('treats negative or NaN attempts as the first attempt', () => {
    expect(nextBackoffMs(-1)).toBe(1000);
    expect(nextBackoffMs(Number.NaN)).toBe(1000);
  });
});

describe('jitteredBackoffMs', () => {
  it('spreads the delay over the upper half of the exponential step', () => {
    expect(jitteredBackoffMs(2, () => 0)).toBe(2000);
    expect(jitteredBackoffMs(2, () => 0.5)).toBe(3000);
    expect(jitteredBackoffMs(2, () => 1)).toBe(4000);
  });

  it('never exceeds the 30 s cap', () => {
    expect(jitteredBackoffMs(50, () => 1)).toBe(30_000);
  });

  it('stays within [ceiling / 2, ceiling] for the default random source', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceiling = nextBackoffMs(attempt);
      const delay = jitteredBackoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });
});
