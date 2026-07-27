import { PERMISSION_CATEGORIES } from '@squad/shared-config';
import { describe, expect, it } from 'vitest';

describe('RoleEditor', () => {
  it('exports a React component function', async () => {
    const mod = await import('./RoleEditor');
    expect(typeof mod.RoleEditor).toBe('function');
  });

  /**
   * `CATEGORY_ORDER` is an unguarded mirror of the closed `PERMISSION_CATEGORIES`
   * tuple: a permission key in a category the editor does not list silently
   * disappears from the role editor. This asserts the two stay in lockstep.
   */
  it('lists every declared permission category exactly once', async () => {
    const { CATEGORY_ORDER } = await import('./RoleEditor');
    const ids = CATEGORY_ORDER.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...PERMISSION_CATEGORIES].sort());
    for (const entry of CATEGORY_ORDER) {
      expect(entry.label, `empty label for category ${entry.id}`).toBeTruthy();
    }
  });
});
