import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backfillMonths, periodsToRecompute, recomputeBonusAccruals, recomputeLeaderboardPeriods } =
  vi.hoisted(() => ({
    backfillMonths: vi.fn(),
    periodsToRecompute: vi.fn(() => [
      { periodType: 'day', periodStart: '2026-07-05' },
      { periodType: 'week', periodStart: '2026-06-29' },
    ]),
    recomputeBonusAccruals: vi.fn(),
    recomputeLeaderboardPeriods: vi.fn(),
  }));

vi.mock('@squad/db', () => ({
  backfillMonths,
  periodsToRecompute,
  recomputeBonusAccruals,
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

import {
  resolveBackfillMonths,
  resolveTickIntervalMs,
  runLeaderboardAggregatorTick,
  runStartupBackfill,
} from '../src/index.js';

describe('runLeaderboardAggregatorTick', () => {
  beforeEach(() => {
    recomputeLeaderboardPeriods.mockReset();
    recomputeBonusAccruals.mockReset();
    recomputeBonusAccruals.mockResolvedValue(0);
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

  it('recomputes the bonus accrual window and folds its count into run_ok (ECON-5)', async () => {
    recomputeLeaderboardPeriods.mockResolvedValue(5);
    recomputeBonusAccruals.mockResolvedValue(11);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-07-05T02:00:00.000Z');
    const sql = {} as never;

    await runLeaderboardAggregatorTick({ sql, diag, now });

    expect(recomputeBonusAccruals).toHaveBeenCalledWith(sql, now);
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'leaderboard_aggregator.run_ok',
        payload: expect.objectContaining({ bonusAccrualRows: 11 }),
      }),
    );
  });

  it('keeps the tick alive and emits run_ok when the bonus accrual recompute fails', async () => {
    recomputeLeaderboardPeriods.mockResolvedValue(5);
    recomputeBonusAccruals.mockRejectedValue(new Error('accruals boom'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runLeaderboardAggregatorTick({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'leaderboard_aggregator.bonus_accruals_failed',
        severity: 'error',
      }),
    );
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.run_ok', severity: 'info' }),
    );
    expect(diag.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.run_failed' }),
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

describe('interval and backfill configuration (DOSSIER-4)', () => {
  beforeEach(() => {
    backfillMonths.mockReset();
  });

  it('respects LEADERBOARD_AGGREGATOR_INTERVAL_MS', () => {
    expect(resolveTickIntervalMs({ LEADERBOARD_AGGREGATOR_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(resolveTickIntervalMs({})).toBe(15 * 60 * 1000);
    expect(resolveTickIntervalMs({ LEADERBOARD_AGGREGATOR_INTERVAL_MS: 'not-a-number' })).toBe(
      15 * 60 * 1000,
    );
    expect(resolveTickIntervalMs({ LEADERBOARD_AGGREGATOR_INTERVAL_MS: '-5' })).toBe(
      15 * 60 * 1000,
    );
  });

  it('parses LEADERBOARD_BACKFILL_MONTHS with a disabled default', () => {
    expect(resolveBackfillMonths({})).toBe(0);
    expect(resolveBackfillMonths({ LEADERBOARD_BACKFILL_MONTHS: '0' })).toBe(0);
    expect(resolveBackfillMonths({ LEADERBOARD_BACKFILL_MONTHS: '6' })).toBe(6);
    expect(resolveBackfillMonths({ LEADERBOARD_BACKFILL_MONTHS: 'junk' })).toBe(0);
    expect(resolveBackfillMonths({ LEADERBOARD_BACKFILL_MONTHS: '-2' })).toBe(0);
  });

  it('runs backfill only when LEADERBOARD_BACKFILL_MONTHS > 0', async () => {
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const sql = {} as never;
    backfillMonths.mockResolvedValue(42);

    expect(await runStartupBackfill({ sql, diag }, 0)).toBe(0);
    expect(backfillMonths).not.toHaveBeenCalled();
    expect(diag.emit).not.toHaveBeenCalled();

    expect(await runStartupBackfill({ sql, diag }, 3)).toBe(42);
    expect(backfillMonths).toHaveBeenCalledWith(sql, 3);
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaderboard_aggregator.backfill_ok', severity: 'info' }),
    );
  });

  it('emits backfill_failed without throwing when the backfill errors', async () => {
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    backfillMonths.mockRejectedValue(new Error('boom'));

    expect(await runStartupBackfill({ sql: {} as never, diag }, 2)).toBe(0);
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'leaderboard_aggregator.backfill_failed',
        severity: 'error',
      }),
    );
  });
});
