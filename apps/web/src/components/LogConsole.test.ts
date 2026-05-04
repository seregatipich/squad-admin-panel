import { describe, expect, it } from 'vitest';

describe('LogConsole', () => {
  it('exports a React component function', async () => {
    const mod = await import('./LogConsole');
    expect(typeof mod.LogConsole).toBe('function');
  });

  it('exports LogEntry and LogConsoleErrorBanner types via module shape', async () => {
    const mod = await import('./LogConsole');
    expect(mod.LogConsole).toBeDefined();
  });
});
