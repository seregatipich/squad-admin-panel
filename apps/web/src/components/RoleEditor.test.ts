import { describe, expect, it } from 'vitest';

describe('RoleEditor', () => {
  it('exports a React component function', async () => {
    const mod = await import('./RoleEditor');
    expect(typeof mod.RoleEditor).toBe('function');
  });
});
