import { describe, expect, it } from 'vitest';

describe('ForceStopDialog', () => {
  it('exports a React component function', async () => {
    const mod = await import('./ForceStopDialog');
    expect(typeof mod.ForceStopDialog).toBe('function');
  });
});
