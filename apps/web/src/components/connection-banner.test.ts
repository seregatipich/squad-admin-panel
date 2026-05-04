import { describe, expect, it } from 'vitest';

describe('ConnectionBanner', () => {
  it('exports a React component function', async () => {
    const mod = await import('./connection-banner');
    expect(typeof mod.ConnectionBanner).toBe('function');
  });
});
