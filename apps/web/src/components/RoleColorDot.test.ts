import { describe, expect, it } from 'vitest';

describe('RoleColorDot', () => {
  it('exports a React component function', async () => {
    const mod = await import('./RoleColorDot');
    expect(typeof mod.RoleColorDot).toBe('function');
  });
});
