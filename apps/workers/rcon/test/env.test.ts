import { describe, expect, it } from 'vitest';
import { positiveIntEnv } from '../src/env.js';

describe('positiveIntEnv', () => {
  it('reads a positive integer', () => {
    expect(positiveIntEnv('2000')).toBe(2000);
    expect(positiveIntEnv(' 1 ')).toBe(1);
  });

  it.each([undefined, '', '   ', '0', '-5', '1.5', 'fast'])('keeps the default for %j', (value) => {
    expect(positiveIntEnv(value)).toBeUndefined();
  });
});
