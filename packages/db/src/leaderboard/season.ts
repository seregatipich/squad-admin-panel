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
  /**
   * Inclusive UTC day window: `fromDay` is the day of `starts_at`, `toDay` the
   * day of the last instant before `ends_at` (see {@link loadSeasonTarget}).
   */
  range: DayRange;
}

interface SeasonTargetRow {
  id: string;
  name: string;
  from_day: string;
  to_day: string;
}

function toRecomputeTarget(row: SeasonTargetRow): SeasonRecomputeTarget {
  return {
    id: row.id,
    name: row.name,
    periodType: 'season',
    periodStart: row.from_day,
    range: { fromDay: row.from_day, toDay: row.to_day },
  };
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
 * `ends_at` is an exclusive instant; see {@link loadSeasonTarget}.
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
  const rows = await sql<SeasonTargetRow[]>`
    SELECT id,
           name,
           to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS from_day,
           to_char((ends_at - INTERVAL '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS to_day
    FROM seasons
    WHERE status = 'active' AND finalized = false
    LIMIT 1
  `;
  const row = rows[0];
  return row ? toRecomputeTarget(row) : null;
}

/**
 * Loads one season's recompute target by id, whatever its status — the
 * scheduler uses it for the last recompute right before finalisation (#1110).
 *
 * `ends_at` is an **exclusive instant** everywhere: the scheduler freezes a
 * season once `now >= ends_at`, so the last day that can hold season data is
 * the UTC day of `ends_at - 1 ms`. The UI stores a chosen end date as
 * `D T00:00Z`, which therefore makes `D - 1` the last counted day; a mid-day
 * `ends_at` still counts its own day.
 *
 * @param sql - postgres.js connection.
 * @param seasonId - season primary key.
 * @returns the recompute target, or `null` when the season does not exist.
 */
export async function loadSeasonTarget(
  sql: postgres.Sql,
  seasonId: string,
): Promise<SeasonRecomputeTarget | null> {
  const rows = await sql<SeasonTargetRow[]>`
    SELECT id,
           name,
           to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS from_day,
           to_char((ends_at - INTERVAL '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS to_day
    FROM seasons
    WHERE id = ${seasonId}
  `;
  const row = rows[0];
  return row ? toRecomputeTarget(row) : null;
}
