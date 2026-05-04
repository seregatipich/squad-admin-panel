import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));
vi.mock('@squad/shared-config', () => ({
  startHeartbeat: vi.fn(() => vi.fn()),
}));
vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { type ArchiverRunDeps, runArchiverCycle } from '../src/index.js';

describe('audit-archiver index', () => {
  it('exports runArchiverCycle', () => {
    expect(runArchiverCycle).toBeDefined();
    expect(typeof runArchiverCycle).toBe('function');
  });

  it('runArchiverCycle emits diag event', async () => {
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    await runArchiverCycle({ diag } as ArchiverRunDeps);
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audit_archiver.run_ok' }),
    );
  });
});
