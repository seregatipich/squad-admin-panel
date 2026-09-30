import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a canonical UUID in either case', () => {
    expect(isUuid('b1e2c3d4-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid('B1E2C3D4-0000-0000-0000-00000000000A')).toBe(true);
  });

  it('rejects anything a route segment could smuggle', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('../../api/v1/admin')).toBe(false);
    expect(isUuid('b1e2c3d4-0000-0000-0000-000000000001/../x')).toBe(false);
  });
});
