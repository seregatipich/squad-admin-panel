import { describe, expect, it } from 'vitest';

describe('DockerPruneButton', () => {
  it('exports a React component function', async () => {
    const mod = await import('./DockerPruneButton');
    expect(typeof mod.DockerPruneButton).toBe('function');
  });
});
