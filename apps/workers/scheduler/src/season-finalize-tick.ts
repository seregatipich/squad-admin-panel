import type { Diag } from '@squad/diag';

/** One `active`, not-yet-finalized row from `seasons` (LEAD-7, #178). */
export interface ActiveSeason {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
}

export interface SeasonFinalizeAuditEntry {
  actor: { kind: 'system'; label: 'season-finalizer' };
  actionType: 'season.finalize';
  targetType: 'season';
  targetId: string;
  context: Record<string, unknown>;
}

export interface SeasonFinalizeTickDeps {
  now?: Date;
  loadActiveSeasons(): Promise<ActiveSeason[]>;
  /** Sets `status = 'closed'` and `finalized = true` for the given season. */
  finalizeSeason(seasonId: string): Promise<void>;
  invalidateLeaderboardCache(): Promise<number>;
  writeAuditEntry(entry: SeasonFinalizeAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface SeasonFinalizeTickResult {
  finalized: number;
  failed: number;
}

/** A season is due for finalisation once the clock reaches its `ends_at`. */
export function isSeasonExpired(season: ActiveSeason, now: Date): boolean {
  return season.endsAt.getTime() <= now.getTime();
}

/**
 * Closes and freezes every active season whose `ends_at` has passed
 * (LEAD-7, #178, the AUTO-2 half).
 *
 * Finalisation is what stops the leaderboard aggregator from recomputing a
 * season: `loadActiveSeasonTarget` only returns active, non-finalized rows, so
 * flipping both columns permanently freezes the materialised slice. The
 * leaderboard cache is flushed afterwards so the frozen numbers become visible
 * without waiting out the TTL.
 *
 * A season that fails to close is counted and retried on the next tick rather
 * than aborting the run; a failure to *load* the seasons is fatal for the tick
 * and rethrown, matching the other scheduler ticks.
 */
export async function runSeasonFinalizeTick(
  deps: SeasonFinalizeTickDeps,
): Promise<SeasonFinalizeTickResult> {
  const now = deps.now ?? new Date();
  let finalized = 0;
  let failed = 0;

  try {
    for (const season of await deps.loadActiveSeasons()) {
      if (!isSeasonExpired(season, now)) continue;

      try {
        await deps.finalizeSeason(season.id);
      } catch (error) {
        failed++;
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'season_finalize.finalize_failed',
          severity: 'error',
          message: `season ${season.id} finalize failed: ${String(error)}`,
          payload: { season_id: season.id, name: season.name },
        });
        continue;
      }

      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'season-finalizer' },
        actionType: 'season.finalize',
        targetType: 'season',
        targetId: season.id,
        context: {
          name: season.name,
          starts_at: season.startsAt.toISOString(),
          ends_at: season.endsAt.toISOString(),
        },
      });
      finalized++;
    }

    if (finalized > 0) await deps.invalidateLeaderboardCache();

    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'season_finalize.run_ok',
      severity: 'info',
      message: `finalized ${finalized} season${finalized === 1 ? '' : 's'}`,
      payload: { finalized, failed },
    });
    return { finalized, failed };
  } catch (error) {
    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'season_finalize.run_failed',
      severity: 'error',
      message: `season finalize tick failed: ${String(error)}`,
      payload: { err: String(error) },
    });
    throw error;
  }
}
