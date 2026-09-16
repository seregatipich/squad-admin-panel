import { describe, expect, it } from 'vitest';

describe('LogoutButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./LogoutButton');
    expect(typeof mod.LogoutButton).toBe('function');
  });
});
