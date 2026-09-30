import { describe, expect, it } from 'vitest';
import {
  hasPgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../src/lib/pg-errors.js';

describe('hasPgErrorCode', () => {
  it('matches the code on the thrown error itself', () => {
    expect(hasPgErrorCode({ code: PG_UNIQUE_VIOLATION }, PG_UNIQUE_VIOLATION)).toBe(true);
  });

  it('matches a code nested several causes deep, as drizzle wraps the driver error', () => {
    const wrapped = new Error('outer', {
      cause: new Error('middle', { cause: { code: PG_FOREIGN_KEY_VIOLATION } }),
    });
    expect(hasPgErrorCode(wrapped, PG_FOREIGN_KEY_VIOLATION)).toBe(true);
  });

  it('does not match a different code, a missing code or non-object throwables', () => {
    expect(hasPgErrorCode({ code: PG_UNIQUE_VIOLATION }, PG_FOREIGN_KEY_VIOLATION)).toBe(false);
    expect(hasPgErrorCode(new Error('plain'), PG_UNIQUE_VIOLATION)).toBe(false);
    expect(hasPgErrorCode(null, PG_UNIQUE_VIOLATION)).toBe(false);
    expect(hasPgErrorCode('23505', PG_UNIQUE_VIOLATION)).toBe(false);
  });

  it('stops following the cause chain after five links', () => {
    let err: unknown = { code: PG_UNIQUE_VIOLATION };
    for (let i = 0; i < 5; i++) err = { cause: err };
    expect(hasPgErrorCode(err, PG_UNIQUE_VIOLATION)).toBe(false);
  });
});
