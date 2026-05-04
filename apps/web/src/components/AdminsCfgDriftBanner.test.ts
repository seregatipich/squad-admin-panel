import { describe, expect, it } from 'vitest';

describe('AdminsCfgDriftBanner', () => {
  it('exports a React component function', async () => {
    const mod = await import('./AdminsCfgDriftBanner');
    expect(typeof mod.AdminsCfgDriftBanner).toBe('function');
  });
});
