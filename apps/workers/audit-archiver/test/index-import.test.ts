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

import * as archiver from '../src/index.js';

describe('audit-archiver index', () => {
  it('does not export a cycle that would report archiver success', () => {
    expect(Object.keys(archiver)).not.toContain('runArchiverCycle');
  });
});
