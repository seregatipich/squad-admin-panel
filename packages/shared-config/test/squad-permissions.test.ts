import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_SQUAD_PERMISSIONS,
  isDangerousSquadPermission,
  isSquadPermissionKey,
  SQUAD_PERMISSION_KEYS,
  SQUAD_PERMISSIONS,
} from '../src/squad-permissions.js';

describe('SQUAD_PERMISSIONS catalogue', () => {
  it('contains exactly the 21 Squad permission keys', () => {
    expect(SQUAD_PERMISSION_KEYS).toHaveLength(21);
    expect(new Set(SQUAD_PERMISSION_KEYS).size).toBe(21);
  });

  it('marks dangerous permissions correctly', () => {
    expect(DANGEROUS_SQUAD_PERMISSIONS.has('kick')).toBe(true);
    expect(DANGEROUS_SQUAD_PERMISSIONS.has('ban')).toBe(true);
    expect(DANGEROUS_SQUAD_PERMISSIONS.has('changemap')).toBe(true);
    expect(DANGEROUS_SQUAD_PERMISSIONS.has('manageserver')).toBe(true);
    expect(DANGEROUS_SQUAD_PERMISSIONS.has('reserve')).toBe(false);
  });

  it('isSquadPermissionKey accepts known keys and rejects unknown', () => {
    expect(isSquadPermissionKey('kick')).toBe(true);
    expect(isSquadPermissionKey('totally-fake')).toBe(false);
  });

  it('isDangerousSquadPermission mirrors the dangerous flag', () => {
    expect(isDangerousSquadPermission('kick')).toBe(true);
    expect(isDangerousSquadPermission('reserve')).toBe(false);
  });

  it('every entry has a non-empty label and description', () => {
    for (const def of SQUAD_PERMISSIONS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});
