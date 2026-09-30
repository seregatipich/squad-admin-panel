import { describe, expect, it } from 'vitest';
import { resolveE2eDatabase } from '../e2e/db-guard';

describe('resolveE2eDatabase', () => {
  it('refuses the shared admin database', () => {
    expect(() => resolveE2eDatabase('admin')).toThrow(/shared development database/);
  });

  it('refuses an unset or blank value instead of defaulting to admin', () => {
    expect(() => resolveE2eDatabase(undefined)).toThrow(/not set/);
    expect(() => resolveE2eDatabase('  ')).toThrow(/not set/);
  });

  it('accepts an isolated database name', () => {
    expect(resolveE2eDatabase('e2e_w6')).toBe('e2e_w6');
  });
});
