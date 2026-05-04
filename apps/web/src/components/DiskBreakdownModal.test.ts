import { describe, expect, it } from 'vitest';

describe('DiskBreakdownModal', () => {
  it('exports a React component function', async () => {
    const mod = await import('./DiskBreakdownModal');
    expect(typeof mod.DiskBreakdownModal).toBe('function');
  });
});
