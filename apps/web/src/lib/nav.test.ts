import { describe, expect, it } from 'vitest';
import { flattenNavItems, NAV_GROUPS } from './nav';

describe('NAV_GROUPS', () => {
  it('contains the dashboard as the first item', () => {
    expect(NAV_GROUPS[0]?.items[0]).toEqual({ href: '/dashboard', label: 'Дашборд' });
  });

  it('has unique hrefs across every group', () => {
    const hrefs = flattenNavItems(NAV_GROUPS).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('flattenNavItems', () => {
  it('drops group labels and concatenates items in order', () => {
    const flat = flattenNavItems([
      { items: [{ href: '/a', label: 'A' }] },
      { label: 'Group', items: [{ href: '/b', label: 'B', permission: 'x:view' }] },
    ]);
    expect(flat).toEqual([
      { href: '/a', label: 'A' },
      { href: '/b', label: 'B', permission: 'x:view' },
    ]);
  });

  it('returns an empty list for no groups', () => {
    expect(flattenNavItems([])).toEqual([]);
  });
});
