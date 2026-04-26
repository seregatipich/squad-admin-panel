import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { isPermissionKey, PERMISSION_KEYS } from '../../src/permissions.js';

const KEYS_COPY = [...PERMISSION_KEYS] as string[];

describe('permission registry properties', () => {
  test.prop([fc.constantFrom(...KEYS_COPY)])(
    'every registered key passes isPermissionKey',
    (key) => {
      expect(isPermissionKey(key)).toBe(true);
    },
  );

  test.prop([
    fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !PERMISSION_KEYS.includes(s as never)),
  ])('unregistered strings are rejected', (s) => {
    expect(isPermissionKey(s)).toBe(false);
  });

  test.prop([
    fc.subarray(KEYS_COPY, {
      minLength: 0,
      maxLength: KEYS_COPY.length,
    }),
  ])('every subset is a valid set of permissions for a role', (subset) => {
    for (const key of subset) expect(isPermissionKey(key)).toBe(true);
  });
});
