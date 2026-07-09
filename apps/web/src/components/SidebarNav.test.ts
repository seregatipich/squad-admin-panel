import { describe, expect, it } from 'vitest';

describe('SidebarNav', () => {
  it('exports a React component function', async () => {
    const mod = await import('./SidebarNav');
    expect(typeof mod.SidebarNav).toBe('function');
  });

  it('lists /vips under the "Управление" group, gated on user:view', async () => {
    const { GROUPS } = await import('./SidebarNav');
    const managementGroup = GROUPS.find((g) => g.label === 'Управление');
    const vipsItem = managementGroup?.items.find((item) => item.href === '/vips');
    expect(vipsItem).toEqual({ href: '/vips', label: 'VIP', permission: 'user:view' });
  });
});
