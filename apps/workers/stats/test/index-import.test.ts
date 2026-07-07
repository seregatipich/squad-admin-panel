import { describe, expect, it, vi } from 'vitest';

vi.mock('@squad/db', () => ({ reconcileDossierAggregates: vi.fn() }));
vi.mock('ioredis', () => ({ default: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })) }));
vi.mock('@squad/shared-config', () => ({ startHeartbeat: vi.fn(() => vi.fn()) }));
vi.mock('@squad/diag', () => ({ createDiag: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { runStatsReconcileTick } from '../src/index.js';

describe('stats index', () => {
  it('exports runStatsReconcileTick without starting the worker on import', () => {
    expect(runStatsReconcileTick).toBeDefined();
    expect(typeof runStatsReconcileTick).toBe('function');
  });
});
