import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSION_CATEGORIES,
  PERMISSION_KEYS,
  PERMISSIONS,
  type PermissionDef,
} from '../src/permissions.js';

describe('PERMISSIONS registry', () => {
  it('keys are unique', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every category is declared in PERMISSION_CATEGORIES', () => {
    const cats = new Set<string>(PERMISSION_CATEGORIES);
    for (const p of PERMISSIONS) {
      expect(cats.has(p.category), `bad category for ${p.key}: ${p.category}`).toBe(true);
    }
  });

  it('dangerous and unimplemented are true | undefined (never false)', () => {
    for (const p of PERMISSIONS as readonly PermissionDef[]) {
      if ('dangerous' in p) expect(p.dangerous).toBe(true);
      if ('unimplemented' in p) expect(p.unimplemented).toBe(true);
    }
  });

  it('every key has a non-empty label', () => {
    for (const p of PERMISSIONS) {
      expect(p.label, `empty label for ${p.key}`).toBeTruthy();
    }
  });

  it('admin group permissions are production-active', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));

    expect(byKey.get('admin_group:view')?.unimplemented).toBeUndefined();
    expect(byKey.get('admin_group:edit')?.unimplemented).toBeUndefined();
  });

  it('exposes server:download_logs as a production-active servers permission', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));
    const def = byKey.get('server:download_logs');
    expect(def).toBeDefined();
    expect(def?.category).toBe('servers');
    expect(def?.unimplemented).toBeUndefined();
    expect(def?.dangerous).toBeUndefined();
  });

  it('marks every mod:* key as implemented', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));

    expect(byKey.get('mod:kick')?.unimplemented).toBeUndefined();
    expect(byKey.get('mod:warn')?.unimplemented).toBeUndefined();
    expect(byKey.get('mod:ban_temp')?.unimplemented).toBeUndefined();
    expect(byKey.get('mod:ban_perm')?.unimplemented).toBeUndefined();
    expect(byKey.get('mod:unban')?.unimplemented).toBeUndefined();
  });

  it('exposes the balancer category with a production-active view/edit pair (GAME-2, #81)', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));

    expect(PERMISSION_CATEGORIES).toContain('balancer');
    expect(byKey.get('balancer:view')?.category).toBe('balancer');
    expect(byKey.get('balancer:edit')?.category).toBe('balancer');
    expect(byKey.get('balancer:view')?.unimplemented).toBeUndefined();
    expect(byKey.get('balancer:edit')?.unimplemented).toBeUndefined();
  });

  it('PERMISSION_KEYS matches PERMISSIONS', () => {
    expect(PERMISSION_KEYS).toEqual(PERMISSIONS.map((p) => p.key));
  });

  it('isPermissionKey narrows correctly', () => {
    expect(isPermissionKey('server:view')).toBe(true);
    expect(isPermissionKey('not-a-key')).toBe(false);
  });
});
