import { describe, expect, it } from 'vitest';
import { positiveIntEnv, requiredTickIntervalMs } from '../src/env.js';

describe('positiveIntEnv', () => {
  it('returns undefined for unset or blank values', () => {
    expect(positiveIntEnv(undefined)).toBeUndefined();
    expect(positiveIntEnv('')).toBeUndefined();
    expect(positiveIntEnv('   ')).toBeUndefined();
  });

  it('returns undefined for non-positive or non-integer values', () => {
    expect(positiveIntEnv('0')).toBeUndefined();
    expect(positiveIntEnv('-5')).toBeUndefined();
    expect(positiveIntEnv('1.5')).toBeUndefined();
    expect(positiveIntEnv('1h')).toBeUndefined();
  });

  it('parses a positive integer', () => {
    expect(positiveIntEnv('60000')).toBe(60_000);
  });
});

describe('requiredTickIntervalMs (#984)', () => {
  it('falls back to the default when unset', () => {
    expect(requiredTickIntervalMs('X', undefined, 60_000)).toBe(60_000);
    expect(requiredTickIntervalMs('X', '', 60_000)).toBe(60_000);
  });

  it('uses the configured value when it is a valid positive integer', () => {
    expect(requiredTickIntervalMs('X', '5000', 60_000)).toBe(5000);
  });

  it('throws instead of silently producing a runaway interval for an invalid value', () => {
    // The bug this guards against (#984): `Number('1h')` is NaN, and Node's
    // setInterval/setTimeout treat a NaN or non-positive delay as ~1ms —
    // previously that meant the tick ran roughly a thousand times a second.
    expect(() => requiredTickIntervalMs('X', '1h', 60_000)).toThrow(/positive integer/);
    expect(() => requiredTickIntervalMs('X', '0', 60_000)).toThrow(/positive integer/);
    expect(() => requiredTickIntervalMs('X', '-1000', 60_000)).toThrow(/positive integer/);
  });
});
