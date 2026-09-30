import { describe, expect, it, vi } from 'vitest';
import {
  type ActiveSeason,
  isSeasonExpired,
  runSeasonFinalizeTick,
  SEASON_FINALIZE_GRACE_MS,
  type SeasonFinalizeTickDeps,
} from '../src/season-finalize-tick.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function makeSeason(overrides: Partial<ActiveSeason> = {}): ActiveSeason {
  return {
    id: '019f46a1-0000-7000-8000-000000000001',
    name: 'Summer 2026',
    startsAt: new Date('2026-06-01T00:00:00.000Z'),
    endsAt: new Date('2026-07-19T00:00:00.000Z'),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SeasonFinalizeTickDeps> = {}): SeasonFinalizeTickDeps {
  return {
    now: NOW,
    loadActiveSeasons: vi.fn().mockResolvedValue([]),
    recomputeSeason: vi.fn().mockResolvedValue(undefined),
    finalizeSeason: vi.fn().mockResolvedValue(undefined),
    invalidateLeaderboardCache: vi.fn().mockResolvedValue(0),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('isSeasonExpired', () => {
  it('is true once ends_at has passed', () => {
    expect(isSeasonExpired(makeSeason({ endsAt: new Date('2026-07-19T00:00:00.000Z') }), NOW)).toBe(
      true,
    );
  });

  it('is true exactly at ends_at', () => {
    expect(isSeasonExpired(makeSeason({ endsAt: NOW }), NOW)).toBe(true);
  });

  it('is false while the season is still running', () => {
    expect(isSeasonExpired(makeSeason({ endsAt: new Date('2026-07-21T00:00:00.000Z') }), NOW)).toBe(
      false,
    );
  });
});

describe('runSeasonFinalizeTick', () => {
  it('does nothing when there is no active season', async () => {
    const deps = makeDeps();
    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 0, failed: 0 });
    expect(deps.finalizeSeason).not.toHaveBeenCalled();
    expect(deps.invalidateLeaderboardCache).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'season_finalize.run_ok', severity: 'info' }),
    );
  });

  it('leaves a season that has not reached ends_at alone', async () => {
    const season = makeSeason({ endsAt: new Date('2026-08-01T00:00:00.000Z') });
    const deps = makeDeps({ loadActiveSeasons: vi.fn().mockResolvedValue([season]) });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 0, failed: 0 });
    expect(deps.finalizeSeason).not.toHaveBeenCalled();
    expect(deps.finalizeSeason).not.toHaveBeenCalled();
  });

  it('closes and freezes an expired season, then invalidates the leaderboard cache', async () => {
    const season = makeSeason();
    const deps = makeDeps({ loadActiveSeasons: vi.fn().mockResolvedValue([season]) });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(deps.finalizeSeason).toHaveBeenCalledWith(season.id, expect.any(Object));
    expect(deps.invalidateLeaderboardCache).toHaveBeenCalledOnce();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'season_finalize.run_ok',
        payload: expect.objectContaining({ finalized: 1 }),
      }),
    );
  });

  it('waits out the grace period after ends_at so presence-daily can close the last day (#1110)', async () => {
    const season = makeSeason({ endsAt: new Date(NOW.getTime() - SEASON_FINALIZE_GRACE_MS + 1) });
    const deps = makeDeps({ loadActiveSeasons: vi.fn().mockResolvedValue([season]) });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 0, failed: 0 });
    expect(deps.recomputeSeason).not.toHaveBeenCalled();
    expect(deps.finalizeSeason).not.toHaveBeenCalled();
  });

  it('runs a last recompute before freezing the season (#1110)', async () => {
    const season = makeSeason();
    const order: string[] = [];
    const deps = makeDeps({
      loadActiveSeasons: vi.fn().mockResolvedValue([season]),
      recomputeSeason: vi.fn().mockImplementation(async () => {
        order.push('recompute');
      }),
      finalizeSeason: vi.fn().mockImplementation(async () => {
        order.push('finalize');
      }),
    });

    await runSeasonFinalizeTick(deps);

    expect(deps.recomputeSeason).toHaveBeenCalledWith(season.id);
    expect(order).toEqual(['recompute', 'finalize']);
  });

  it('does not freeze the season when the last recompute fails, so the next tick retries (#1110)', async () => {
    const season = makeSeason();
    const deps = makeDeps({
      loadActiveSeasons: vi.fn().mockResolvedValue([season]),
      recomputeSeason: vi.fn().mockRejectedValue(new Error('recompute boom')),
    });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 0, failed: 1 });
    expect(deps.finalizeSeason).not.toHaveBeenCalled();
  });

  it('records the finalisation in the audit trail', async () => {
    const season = makeSeason();
    const deps = makeDeps({ loadActiveSeasons: vi.fn().mockResolvedValue([season]) });

    await runSeasonFinalizeTick(deps);

    expect(deps.finalizeSeason).toHaveBeenCalledWith(
      season.id,
      expect.objectContaining({
        actor: { kind: 'system', label: 'season-finalizer' },
        actionType: 'season.finalize',
        targetType: 'season',
        targetId: season.id,
        context: expect.objectContaining({
          name: 'Summer 2026',
          ends_at: '2026-07-19T00:00:00.000Z',
        }),
      }),
    );
  });

  it('counts a failed finalisation, keeps the tick alive and skips the cache flush', async () => {
    const season = makeSeason();
    const deps = makeDeps({
      loadActiveSeasons: vi.fn().mockResolvedValue([season]),
      finalizeSeason: vi.fn().mockRejectedValue(new Error('update boom')),
    });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 0, failed: 1 });
    expect(deps.invalidateLeaderboardCache).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'season_finalize.finalize_failed', severity: 'error' }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'season_finalize.run_ok' }),
    );
  });

  it('emits run_failed and rethrows when loading the seasons fails', async () => {
    const deps = makeDeps({
      loadActiveSeasons: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(runSeasonFinalizeTick(deps)).rejects.toThrow('db down');
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'season_finalize.run_failed', severity: 'error' }),
    );
  });

  it('defaults `now` to the current clock when it is not injected', async () => {
    const longExpired = makeSeason({ endsAt: new Date('2020-01-01T00:00:00.000Z') });
    const deps = makeDeps({
      now: undefined,
      loadActiveSeasons: vi.fn().mockResolvedValue([longExpired]),
    });

    const result = await runSeasonFinalizeTick(deps);

    expect(result).toEqual({ finalized: 1, failed: 0 });
  });
});
