import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('server.ts module', () => {
  it('exports buildServer as a function', () => {
    expect(typeof buildServer).toBe('function');
  });
});
