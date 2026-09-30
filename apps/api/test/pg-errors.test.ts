import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../src/lib/pg-errors.js';

describe('isUniqueViolation', () => {
  it('matches a bare 23505 error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('walks the drizzle cause chain', () => {
    const err = new Error('wrapped', { cause: new Error('inner', { cause: { code: '23505' } }) });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('ignores other SQLSTATEs and non-objects', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('stops after five levels of cause', () => {
    let err: unknown = { code: '23505' };
    for (let i = 0; i < 6; i++) err = { cause: err };
    expect(isUniqueViolation(err)).toBe(false);
  });

  it('filters by constraint name when one is given', () => {
    const slug = { cause: { code: '23505', constraint_name: 'mark_types_slug_key' } };
    const pk = { cause: { code: '23505', constraint_name: 'mark_types_pkey' } };
    expect(isUniqueViolation(slug, 'mark_types_slug_key')).toBe(true);
    expect(isUniqueViolation(pk, 'mark_types_slug_key')).toBe(false);
  });
});
