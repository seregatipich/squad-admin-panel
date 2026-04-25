import { describe, expect, it } from 'vitest';
import { nextBackoffMs } from './ws-backoff';

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
