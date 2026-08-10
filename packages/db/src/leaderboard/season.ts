import type postgres from 'postgres';
import type { DayRange } from './aggregate.js';

/**
 * The one season the leaderboard aggregator should materialise on a tick,
 * expressed as a ready-to-use `recomputeLeaderboardPeriod` input.
 */
export interface SeasonRecomputeTarget {
  id: string;
  name: string;
  periodType: 'season';
  /** The season's start day, in UTC — the `period_start` its rows are keyed by. */
  periodStart: string;
  /** Inclusive UTC day window `[starts_at, ends_at]`. */
  range: DayRange;
}

/**
 * Loads the season the aggregator should recompute, or `null` when there is
 * none (LEAD-7, #178).
 *
 * Only an `active` season that is **not** finalized qualifies:
 * - `seasons_one_active` guarantees at most one `active` row, which is why a
 *   bare `LIMIT 1` is a complete answer rather than an arbitrary pick.
 * - Skipping `finalized` rows is what makes finalisation stick — once a season
 *   is frozen the aggregator stops touching it, so re-running the tick can no
 *   longer change its materialised rows.
 *
 * The day bounds are formatted **in SQL**, as `AT TIME ZONE 'UTC'` strings,
 * for two reasons. They must be UTC days to line up with
 * `player_daily_presence.day` and the match filters — a bare `starts_at::date`
 * would follow the Postgres session time zone. And the JS-side type of a
 * `timestamptz` is not stable across callers: `drizzle()` replaces the
 * postgres.js type parsers on the client it wraps, so the same tagged-template
 * query yields a `Date` on a bare client (the worker) but a session-local
 * string such as `2026-06-10 02:00:00+02` on a wrapped one (the API and its
 * tests). Formatting in SQL sidesteps that entirely.
 *
 * @param sql - postgres.js connection.
 * @returns the recompute target, or `null` when no live season exists.
 */
export async function loadActiveSeasonTarget(
  sql: postgres.Sql,
): Promise<SeasonRecomputeTarget | null> {
  const rows = await sql<{ id: string; name: string; from_day: string; to_day: string }[]>`
    SELECT id,
           name,
           to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS from_day,
           to_char(ends_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS to_day
    FROM seasons
    WHERE status = 'active' AND finalized = false
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    periodType: 'season',
    periodStart: row.from_day,
    range: { fromDay: row.from_day, toDay: row.to_day },
  };
}
