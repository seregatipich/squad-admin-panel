import { describe, expect, it } from 'vitest';

describe('MetricHistoryModal', () => {
  it('exports a React component function', async () => {
    const mod = await import('./MetricHistoryModal');
    expect(typeof mod.MetricHistoryModal).toBe('function');
  });
});
