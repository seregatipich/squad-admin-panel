import { describe, expect, it, vi } from 'vitest';

// Whole-module replacement: every @squad/db symbol src/index.ts imports must
// appear here, or the import under test fails to resolve.
vi.mock('@squad/db', () => ({
  loadActiveSeasonTarget: vi.fn(async () => null),
  periodsToRecompute: vi.fn(() => []),
  recomputeLeaderboardPeriods: vi.fn(),
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })) }));
vi.mock('@squad/shared-config', () => ({ startHeartbeat: vi.fn(() => vi.fn()) }));
vi.mock('@squad/diag', () => ({ createDiag: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { runLeaderboardAggregatorTick } from '../src/index.js';

describe('leaderboard-aggregator index', () => {
  it('exports runLeaderboardAggregatorTick without starting the worker on import', () => {
    expect(runLeaderboardAggregatorTick).toBeDefined();
    expect(typeof runLeaderboardAggregatorTick).toBe('function');
  });
});
