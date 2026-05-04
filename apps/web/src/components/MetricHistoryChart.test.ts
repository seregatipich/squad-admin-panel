import { describe, expect, it } from 'vitest';

describe('MetricHistoryChart', () => {
  it('exports a default React component function', async () => {
    const mod = await import('./MetricHistoryChart');
    expect(typeof mod.default).toBe('function');
  });
});
