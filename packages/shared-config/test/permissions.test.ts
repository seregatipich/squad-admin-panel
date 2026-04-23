import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSION_KEYS,
  ROLE_CLEARANCE,
  SYSTEM_ROLE_PERMISSIONS,
} from '../src/permissions.js';

describe('permission registry', () => {
  it('has no duplicate keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('Owner role has every permission in the registry', () => {
    for (const key of PERMISSION_KEYS) {
      expect(SYSTEM_ROLE_PERMISSIONS.Owner).toContain(key);
    }
  });

  it('Viewer only gets read-only permissions (view / history segments)', () => {
    for (const key of SYSTEM_ROLE_PERMISSIONS.Viewer) {
      expect(key).toMatch(/(^|:)(view|history)(:|$)/);
    }
  });

  it('isPermissionKey rejects unknown strings', () => {
    expect(isPermissionKey('server:view')).toBe(true);
    expect(isPermissionKey('server:nuke-from-orbit')).toBe(false);
  });

  it('clearance ordering Owner > Senior Admin > Admin > Viewer', () => {
    expect(ROLE_CLEARANCE.OWNER).toBeGreaterThan(ROLE_CLEARANCE.SENIOR_ADMIN);
    expect(ROLE_CLEARANCE.SENIOR_ADMIN).toBeGreaterThan(ROLE_CLEARANCE.ADMIN);
    expect(ROLE_CLEARANCE.ADMIN).toBeGreaterThan(ROLE_CLEARANCE.VIEWER);
  });
});
