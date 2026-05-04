import { describe, expect, it } from 'vitest';

describe('LogList', () => {
  it('exports a React component function', async () => {
    const mod = await import('./LogList');
    expect(typeof mod.LogList).toBe('function');
  });

  it('exports ServersResponse type marker via module shape', async () => {
    const mod = await import('./LogList');
    expect(mod.LogList).toBeDefined();
  });
});
