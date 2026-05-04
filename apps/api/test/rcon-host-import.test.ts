import { describe, expect, it } from 'vitest';

describe('lib/rcon-host.ts', () => {
  it('module is importable', async () => {
    const mod = await import('../src/lib/rcon-host.js');
    expect(mod).toBeDefined();
  });

  it('re-exports resolveRconHost as a function', async () => {
    const { resolveRconHost } = await import('../src/lib/rcon-host.js');
    expect(typeof resolveRconHost).toBe('function');
  });
});
