import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  recomputeDailyPresence,
  recentPresenceWindow,
  recomputeCoplayWindow,
  recentCoplayWindow,
  accrueDailyBonuses,
  daysInWindow,
} = vi.hoisted(() => ({
  recomputeDailyPresence: vi.fn(),
  recentPresenceWindow: vi.fn(() => ({ fromDay: '2026-07-04', toDay: '2026-07-05' })),
  recomputeCoplayWindow: vi.fn(),
  recentCoplayWindow: vi.fn(() => ({ fromDay: '2026-07-04', toDay: '2026-07-05' })),
  accrueDailyBonuses: vi.fn(),
  daysInWindow: vi.fn((from: string, to: string) => (from === to ? [from] : [from, to])),
}));

vi.mock('@squad/db', () => ({
  recomputeDailyPresence,
  recentPresenceWindow,
  recomputeCoplayWindow,
  recentCoplayWindow,
  accrueDailyBonuses,
  daysInWindow,
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })) }));
vi.mock('@squad/shared-config', () => ({ startHeartbeat: vi.fn(() => vi.fn()) }));
vi.mock('@squad/diag', () => ({ createDiag: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { runEconomyAccrual, runPresenceDailyTick } from '../src/index.js';

const ACCRUAL_OK = {
  day: '2026-07-05',
  economyEnabled: true,
  playersAccrued: 1,
  transactionsWritten: 2,
  balanceDelta: 4,
};

describe('runPresenceDailyTick', () => {
  beforeEach(() => {
    recomputeDailyPresence.mockReset();
    recentPresenceWindow.mockClear();
    recomputeCoplayWindow.mockReset();
    recomputeCoplayWindow.mockResolvedValue(0);
    recentCoplayWindow.mockClear();
    accrueDailyBonuses.mockReset();
    accrueDailyBonuses.mockResolvedValue(ACCRUAL_OK);
    daysInWindow.mockClear();
  });

  it('recomputes the recent window and emits run_ok', async () => {
    recomputeDailyPresence.mockResolvedValue(3);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-07-05T02:00:00.000Z');
    const sql = {} as never;

    await runPresenceDailyTick({ sql, diag, now });

    expect(recentPresenceWindow).toHaveBeenCalledWith(now);
    expect(recomputeDailyPresence).toHaveBeenCalledWith(sql, {
      fromDay: '2026-07-04',
      toDay: '2026-07-05',
      now,
    });
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'presence_daily.run_ok', severity: 'info' }),
    );
  });

  it('also recomputes the recent co-play window and emits coplay.run_ok', async () => {
    recomputeDailyPresence.mockResolvedValue(3);
    recomputeCoplayWindow.mockResolvedValue(7);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-07-05T02:00:00.000Z');
    const sql = {} as never;

    await runPresenceDailyTick({ sql, diag, now });

    expect(recentCoplayWindow).toHaveBeenCalledWith(now);
    expect(recomputeCoplayWindow).toHaveBeenCalledWith(sql, {
      fromDay: '2026-07-04',
      toDay: '2026-07-05',
      now,
    });
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'coplay.run_ok', severity: 'info' }),
    );
  });

  it('emits run_failed when the recompute throws', async () => {
    recomputeDailyPresence.mockRejectedValue(new Error('boom'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runPresenceDailyTick({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'presence_daily.run_failed', severity: 'error' }),
    );
  });

  it('emits coplay.run_failed when the co-play recompute throws', async () => {
    recomputeDailyPresence.mockResolvedValue(0);
    recomputeCoplayWindow.mockRejectedValue(new Error('coplay boom'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runPresenceDailyTick({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'coplay.run_failed', severity: 'error' }),
    );
  });

  it('accrues economy bonuses for every day in the window and emits run_ok', async () => {
    recomputeDailyPresence.mockResolvedValue(1);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-07-05T02:00:00.000Z');
    const sql = {} as never;

    await runPresenceDailyTick({ sql, diag, now });

    expect(daysInWindow).toHaveBeenCalledWith('2026-07-04', '2026-07-05');
    expect(accrueDailyBonuses).toHaveBeenCalledWith(sql, { day: '2026-07-04', now });
    expect(accrueDailyBonuses).toHaveBeenCalledWith(sql, { day: '2026-07-05', now });
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'economy_accrual.run_ok', severity: 'info' }),
    );
  });

  it('emits economy_accrual.run_failed when accrual throws', async () => {
    accrueDailyBonuses.mockRejectedValue(new Error('accrual boom'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runEconomyAccrual({
      sql: {} as never,
      diag,
      now: new Date('2026-07-05T02:00:00.000Z'),
    });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'economy_accrual.run_failed', severity: 'error' }),
    );
  });
});
