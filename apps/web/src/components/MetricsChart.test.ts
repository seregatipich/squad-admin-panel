import { describe, expect, it } from 'vitest';

describe('MetricsChart', () => {
  it('exports a React component function', async () => {
    const mod = await import('./MetricsChart');
    expect(typeof mod.MetricsChart).toBe('function');
  });
});
