import { describe, expect, it } from 'vitest';

describe('SidebarNav', () => {
  it('exports a React component function', async () => {
    const mod = await import('./SidebarNav');
    expect(typeof mod.SidebarNav).toBe('function');
  });
});
