import { describe, expect, it } from 'vitest';

describe('plugins/types.ts', () => {
  it('module loads without side effects', async () => {
    const mod = await import('../src/plugins/types.js');
    expect(mod).toBeDefined();
  });
});
