import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reconcileDossierAggregates } = vi.hoisted(() => ({
  reconcileDossierAggregates: vi.fn(),
}));

vi.mock('@squad/db', () => ({ reconcileDossierAggregates }));
vi.mock('ioredis', () => ({ default: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })) }));
vi.mock('@squad/shared-config', () => ({ startHeartbeat: vi.fn(() => vi.fn()) }));
vi.mock('@squad/diag', () => ({ createDiag: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { runStatsReconcileTick } from '../src/index.js';

const noDrift = {
  discrepancies: { weaponStats: 0, vehicleStats: 0, vehicleKills: 0, total: 0 },
  repaired: false,
};

describe('runStatsReconcileTick', () => {
  beforeEach(() => {
    reconcileDossierAggregates.mockReset();
  });

  it('emits run_ok when the aggregates are consistent', async () => {
    reconcileDossierAggregates.mockResolvedValue(noDrift);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const sql = {} as never;

    await runStatsReconcileTick({ sql, diag });

    expect(reconcileDossierAggregates).toHaveBeenCalledWith(sql, { windowHours: 48 });
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dossier_reconcile.run_ok', severity: 'info' }),
    );
  });

  it('emits a drift_detected warning carrying the per-table counts', async () => {
    reconcileDossierAggregates.mockResolvedValue({
      discrepancies: { weaponStats: 2, vehicleStats: 0, vehicleKills: 1, total: 3 },
      repaired: false,
    });
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runStatsReconcileTick({ sql: {} as never, diag });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dossier_reconcile.drift_detected',
        severity: 'warn',
        payload: expect.objectContaining({ total: 3, weaponStats: 2, vehicleKills: 1 }),
      }),
    );
  });

  it('reconciles the last 48h in report-only mode (never repairs) on a scheduled tick', async () => {
    reconcileDossierAggregates.mockResolvedValue(noDrift);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runStatsReconcileTick({ sql: {} as never, diag });

    // Windowed report mode: passes { windowHours: 48 } and never { repair: true }.
    const options = reconcileDossierAggregates.mock.calls[0][1];
    expect(options).toEqual({ windowHours: 48 });
    expect(options).not.toHaveProperty('repair');
  });

  it('emits run_failed when reconcile throws', async () => {
    reconcileDossierAggregates.mockRejectedValue(new Error('db down'));
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runStatsReconcileTick({ sql: {} as never, diag });

    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dossier_reconcile.run_failed', severity: 'error' }),
    );
  });
});
