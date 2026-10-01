import { type DatabaseClient, loadSeasonTarget, recomputeLeaderboardPeriod } from '@squad/db';
import { seasons } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type {
  ActiveSeason,
  SeasonFinalizeAuditEntry,
  SeasonFinalizeTickDeps,
} from '../season-finalize-tick.js';
import { writeSystemAuditEntry } from './shared.js';

// LEAD-7 (#178) — season finalisation.

/** Mirrors CACHE_PREFIX in apps/api/src/routes/leaderboards.ts. */
const LEADERBOARD_CACHE_PREFIX = 'leaderboard:';

/** Active, not-yet-frozen seasons — the only ones the finalize tick may close. */
export async function loadActiveSeasons(db: DatabaseClient): Promise<ActiveSeason[]> {
  const rows = await db
    .select({
      id: seasons.id,
      name: seasons.name,
      startsAt: seasons.startsAt,
      endsAt: seasons.endsAt,
    })
    .from(seasons)
    .where(and(eq(seasons.status, 'active'), eq(seasons.finalized, false)));
  return rows;
}

/**
 * Rebuilds the season's `player_stat_periods` slice from its current window,
 * the same computation the leaderboard aggregator runs each tick (#1110).
 * A season that no longer exists is a no-op: finalizing it then matches no row.
 */
export async function recomputeSeasonSlice(db: DatabaseClient, seasonId: string): Promise<void> {
  const target = await loadSeasonTarget(db.$client, seasonId);
  if (!target) return;
  await recomputeLeaderboardPeriod(db.$client, {
    periodType: target.periodType,
    periodStart: target.periodStart,
    range: target.range,
  });
}

/**
 * Closes a season, freezes its materialised slice and appends its audit row in
 * one transaction, so none of the three can happen without the others. `loadActiveSeasonTarget` in @squad/db skips
 * finalized rows, which is what stops the aggregator recomputing it.
 */
export async function finalizeSeason(
  db: DatabaseClient,
  seasonId: string,
  audit: SeasonFinalizeAuditEntry,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(seasons)
      .set({ status: 'closed', finalized: true, updatedAt: new Date() })
      .where(eq(seasons.id, seasonId));
    await writeSystemAuditEntry(tx, audit);
  });
}

export async function invalidateLeaderboardCache(
  redis: Pick<Redis, 'scanStream' | 'unlink'>,
): Promise<number> {
  let removed = 0;
  const stream = redis.scanStream({ match: `${LEADERBOARD_CACHE_PREFIX}*`, count: 200 });
  for await (const batch of stream as AsyncIterable<string[]>) {
    if (batch.length === 0) continue;
    await redis.unlink(...batch);
    removed += batch.length;
  }
  return removed;
}

export function createSeasonFinalizeDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'scanStream' | 'unlink'>,
): Omit<SeasonFinalizeTickDeps, 'now' | 'diag'> {
  return {
    loadActiveSeasons: () => loadActiveSeasons(db),
    recomputeSeason: (seasonId) => recomputeSeasonSlice(db, seasonId),
    finalizeSeason: (seasonId, audit) => finalizeSeason(db, seasonId, audit),
    invalidateLeaderboardCache: () => invalidateLeaderboardCache(redis),
  };
}
