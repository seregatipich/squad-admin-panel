import { describe, expect, it } from 'vitest';
import { intervalMsFromEnv, MAX_TIMER_DELAY_MS } from './interval.js';

describe('intervalMsFromEnv', () => {
  it('returns the fallback when the value is unset or blank', () => {
    expect(intervalMsFromEnv(undefined, 30_000)).toBe(30_000);
    expect(intervalMsFromEnv('', 30_000)).toBe(30_000);
    expect(intervalMsFromEnv('   ', 30_000)).toBe(30_000);
  });

  it('accepts a positive number up to the timer limit', () => {
    expect(intervalMsFromEnv('5000', 30_000)).toBe(5000);
    expect(intervalMsFromEnv(String(MAX_TIMER_DELAY_MS), 30_000)).toBe(MAX_TIMER_DELAY_MS);
  });

  it.each(['60s', 'NaN', '0', '-5', 'Infinity', String(MAX_TIMER_DELAY_MS + 1), '2592000000'])(
    'falls back for the unusable value %s',
    (raw) => {
      expect(intervalMsFromEnv(raw, 30_000)).toBe(30_000);
    },
  );
});
