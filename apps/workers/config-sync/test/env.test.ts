import { describe, expect, it } from 'vitest';
import { positiveIntEnv } from '../src/env.js';

describe('positiveIntEnv', () => {
  it('returns the fallback when the variable is unset or blank', () => {
    expect(positiveIntEnv('X', 5, {})).toBe(5);
    expect(positiveIntEnv('X', 5, { X: '  ' })).toBe(5);
  });

  it('parses a positive integer', () => {
    expect(positiveIntEnv('X', 5, { X: '1500' })).toBe(1500);
  });

  it.each(['5m', 'NaN', '0', '-3', '1.5', 'Infinity'])('rejects %s', (raw) => {
    expect(() => positiveIntEnv('X', 5, { X: raw })).toThrow(/X must be a positive integer/);
  });
});
