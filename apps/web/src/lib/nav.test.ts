import { describe, expect, it } from 'vitest';
import { ru } from '@/i18n/dictionaries/ru';
import { flattenNavItems, NAV_GROUPS } from './nav';

describe('NAV_GROUPS', () => {
  it('contains the dashboard as the first item', () => {
    expect(NAV_GROUPS[0]?.items[0]).toEqual({
      href: '/dashboard',
      label: 'Дашборд',
      labelKey: 'nav.dashboard',
    });
  });

  it('has unique hrefs across every group', () => {
    const hrefs = flattenNavItems(NAV_GROUPS).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives every item, child item, and labeled group a labelKey', () => {
    for (const group of NAV_GROUPS) {
      if (group.label) expect(group.labelKey, `group ${group.label}`).toBeDefined();
      for (const item of group.items) {
        expect(item.labelKey, `item ${item.label}`).toBeDefined();
        for (const child of item.children ?? []) {
          expect(child.labelKey, `child ${child.label}`).toBeDefined();
        }
      }
    }
  });

  it('gives "Игроки" a children group and no href of its own', () => {
    const management = NAV_GROUPS.find((group) => group.label === 'Управление');
    const players = management?.items.find((item) => item.label === 'Игроки');
    expect(players?.href).toBeUndefined();
    expect(players?.children?.length).toBeGreaterThan(0);
  });

  it('exposes the team balancer under «Управление», gated on balancer:view (GAME-2, #81)', () => {
    const management = NAV_GROUPS.find((group) => group.label === 'Управление');
    expect(management?.items).toContainEqual({
      href: '/balancer',
      label: 'Балансировщик',
      labelKey: 'nav.balancer',
      permission: 'balancer:view',
    });
  });

  it('keeps the Russian dictionary in sync with the legacy `label` (drift guard)', () => {
    for (const group of NAV_GROUPS) {
      if (group.label && group.labelKey) expect(ru[group.labelKey]).toBe(group.label);
      for (const item of group.items) {
        if (item.labelKey) expect(ru[item.labelKey], item.label).toBe(item.label);
        for (const child of item.children ?? []) {
          if (child.labelKey) expect(ru[child.labelKey], child.label).toBe(child.label);
        }
      }
    }
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

  it('expands a group item into its children instead of the group header itself', () => {
    const flat = flattenNavItems([
      {
        label: 'Group',
        items: [
          {
            label: 'Parent',
            children: [
              { href: '/a', label: 'A' },
              { href: '/b', label: 'B' },
            ],
          },
        ],
      },
    ]);
    expect(flat).toEqual([
      { href: '/a', label: 'A' },
      { href: '/b', label: 'B' },
    ]);
  });

  it('returns an empty list for no groups', () => {
    expect(flattenNavItems([])).toEqual([]);
  });
});
