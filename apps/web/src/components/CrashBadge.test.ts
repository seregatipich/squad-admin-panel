import { describe, expect, it } from 'vitest';

describe('CrashBadge', () => {
  it('exports a React component function', async () => {
    const mod = await import('./CrashBadge');
    expect(typeof mod.CrashBadge).toBe('function');
  });
});
