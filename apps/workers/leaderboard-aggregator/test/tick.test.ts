import { beforeEach, describe, expect, it, vi } from 'vitest';

const { periodsToRecompute, recomputeLeaderboardPeriods } = vi.hoisted(() => ({
  periodsToRecompute: vi.fn(() => [
    { periodType: 'day', periodStart: '2026-07-05' },
    { periodType: 'week', periodStart: '2026-06-29' },
  ]),
  recomputeLeaderboardPeriods: vi.fn(),
}));

vi.mock('@squad/db', () => ({
  periodsToRecompute,
  recomputeLeaderboardPeriods,
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

describe('runLeaderboardAggregatorTick', () => {
  beforeEach(() => {
    recomputeLeaderboardPeriods.mockReset();
    periodsToRecompute.mockClear();
  });

  it('recomputes the current periods, invalidates cache and emits run_ok', async () => {
    recomputeLeaderboardPeriods.mockResolvedValue(7);
    const invalidateCache = vi.fn().mockResolvedValue(3);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-07-05T02:00:00.000Z');
    const sql = {} as never;

    await runLeaderboardAggregatorTick({ sql, diag, invalidateCache, now });

    expect(periodsToRecompute).toHaveBeenCalledWith(now);
    expect(recomputeLeaderboardPeriods).toHaveBeenCalledWith(sql, [
      { periodType: 'day', periodStart: '2026-07-05' },
      { periodType: 'week', periodStart: '2026-06-29' },
    ]);
    expect(invalidateCache).toHaveBeenCalledOnce();
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.run_ok', severity: 'info' }),
    );
  });

  it('skips cache invalidation when no invalidator is provided', async () => {
    recomputeLeaderboardPeriods.mockResolvedValue(0);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runLeaderboardAggregatorTick({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.run_ok' }),
    );
  });

  it('emits run_failed when the recompute throws', async () => {
    recomputeLeaderboardPeriods.mockRejectedValue(new Error('boom'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runLeaderboardAggregatorTick({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.run_failed', severity: 'error' }),
    );
  });
});
