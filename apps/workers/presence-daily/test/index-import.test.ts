import { describe, expect, it, vi } from 'vitest';

vi.mock('@squad/db', () => ({
  recomputeDailyPresence: vi.fn(),
  recentPresenceWindow: vi.fn(() => ({ fromDay: '2026-07-04', toDay: '2026-07-05' })),
  recomputeServerDailyStats: vi.fn(),
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })) }));
vi.mock('@squad/shared-config', () => ({ startHeartbeat: vi.fn(() => vi.fn()) }));
vi.mock('@squad/diag', () => ({ createDiag: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { runPresenceDailyTick } from '../src/index.js';

describe('presence-daily index', () => {
  it('exports runPresenceDailyTick without starting the worker on import', () => {
    expect(runPresenceDailyTick).toBeDefined();
    expect(typeof runPresenceDailyTick).toBe('function');
  });
});
