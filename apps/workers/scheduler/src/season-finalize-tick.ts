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
  /**
   * Recomputes the season's materialised leaderboard slice one last time, so
   * data written after the aggregator's final tick (the last day's presence)
   * lands in the frozen totals (#1110). A failure aborts that season's
   * finalisation and is retried on the next tick.
   */
  recomputeSeason(seasonId: string): Promise<void>;
  /**
   * Sets `status = 'closed'` and `finalized = true` for the season and appends
   * its audit row in one transaction: the season never reappears in
   * `loadActiveSeasons` once closed, so a separate audit write that failed
   * would be lost for good.
   */
  finalizeSeason(seasonId: string, audit: SeasonFinalizeAuditEntry): Promise<void>;
  invalidateLeaderboardCache(): Promise<number>;
  diag: Pick<Diag, 'emit'>;
}

export interface SeasonFinalizeTickResult {
  finalized: number;
  failed: number;
}

/**
 * How long after `ends_at` a season waits before it is frozen, so
 * presence-daily (one aggregation interval) has closed the season's last day.
 */
export const SEASON_FINALIZE_GRACE_MS = 15 * 60 * 1000;

/**
 * A season has ended once the clock reaches its `ends_at`, an exclusive
 * instant: the season's last day is the UTC day of `ends_at - 1 ms`.
 */
export function isSeasonExpired(season: ActiveSeason, now: Date): boolean {
  return season.endsAt.getTime() <= now.getTime();
}

/**
 * Closes and freezes every active season whose `ends_at` passed at least
 * {@link SEASON_FINALIZE_GRACE_MS} ago, after one last recompute of its slice
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
      if (now.getTime() < season.endsAt.getTime() + SEASON_FINALIZE_GRACE_MS) continue;

      try {
        await deps.recomputeSeason(season.id);
        await deps.finalizeSeason(season.id, {
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
