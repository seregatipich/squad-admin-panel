import { describe, expect, it } from 'vitest';
import { formatUpdatedAt, validateGracePeriod } from './helpers';

describe('validateGracePeriod', () => {
  it('accepts an in-range integer', () => {
    expect(validateGracePeriod('300')).toEqual({ ok: true, value: 300, error: null });
  });

  it('accepts the boundary values', () => {
    expect(validateGracePeriod('0').ok).toBe(true);
    expect(validateGracePeriod('3600').ok).toBe(true);
  });

  it('rejects a negative value', () => {
    const result = validateGracePeriod('-1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a value above the max', () => {
    const result = validateGracePeriod('3601');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(validateGracePeriod('12.5').ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(validateGracePeriod('').ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(validateGracePeriod('abc').ok).toBe(false);
  });
});

describe('formatUpdatedAt', () => {
  it('returns a placeholder for null', () => {
    expect(formatUpdatedAt(null)).toBe('ещё не изменялось');
  });

  it('formats a valid ISO date', () => {
    expect(formatUpdatedAt('2026-07-14T12:00:00.000Z')).not.toBe('ещё не изменялось');
  });

  it('returns a placeholder for an invalid date string', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('ещё не изменялось');
  });
});
