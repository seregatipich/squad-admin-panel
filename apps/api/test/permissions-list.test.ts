import { PERMISSIONS } from '@squad/shared-config';
import { describe, expect, it } from 'vitest';

describe('PERMISSIONS registry', () => {
  it('exports a non-empty array of permission definitions', () => {
    expect(Array.isArray(PERMISSIONS)).toBe(true);
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('every entry has key, category, and label', () => {
    for (const p of PERMISSIONS) {
      expect(typeof p.key).toBe('string');
      expect(p.key.length).toBeGreaterThan(0);
      expect(typeof p.category).toBe('string');
      expect(typeof p.label).toBe('string');
    }
  });

  it('contains expected role management keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys).toContain('role:view');
    expect(keys).toContain('role:create');
    expect(keys).toContain('role:edit');
    expect(keys).toContain('role:delete');
  });

  it('contains expected user management keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys).toContain('user:view');
    expect(keys).toContain('user:manage_roles');
  });

  it('has no duplicate keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
