import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock('@squad/shared-config', () => ({
  startHeartbeat: vi.fn(() => vi.fn()),
  DIAG_STREAM_KEY: 'diag:queue',
  DIAG_STREAM_MAXLEN: 100000,
}));
vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    unsafe: vi.fn().mockResolvedValue([]),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { ensureDiagPartitions } from '../src/index.js';

describe('event-partition index', () => {
  it('exports ensureDiagPartitions', () => {
    expect(ensureDiagPartitions).toBeDefined();
    expect(typeof ensureDiagPartitions).toBe('function');
  });

  it('ensureDiagPartitions creates partitions via SQL', async () => {
    const taggedTemplate = vi.fn().mockResolvedValue([]);
    const sql = Object.assign(taggedTemplate, {
      unsafe: vi.fn().mockResolvedValue([]),
    }) as unknown as Parameters<typeof ensureDiagPartitions>[0];
    await ensureDiagPartitions(sql);
    expect(sql.unsafe).toHaveBeenCalled();
    const unsafeCalls = (sql.unsafe as ReturnType<typeof vi.fn>).mock.calls;
    expect(unsafeCalls.length).toBeGreaterThanOrEqual(4);
    for (const [query] of unsafeCalls.slice(0, 4)) {
      expect(query).toContain('CREATE TABLE IF NOT EXISTS');
      expect(query).toContain('diagnostic_events_');
    }
  });
});
