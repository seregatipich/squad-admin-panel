import type postgres from 'postgres';
import { splitSessionSecondsByUtcDay, utcDayKey } from '../presence/daily.js';

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

/** Rolling window (in days) over which co-play is aggregated when served. */
export const COPLAY_WINDOW_DAYS = 90;

function dayNumberFromKey(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

export interface CoplaySessionInput {
  connectedAt: Date;
  /** Session end; use `now` for still-open sessions. */
  endAt: Date;
}

/**
 * Split the simultaneous-presence overlap of two sessions into per-UTC-day
 * buckets. The overlap interval is the intersection of the two sessions clipped
 * to day boundaries, so the sum of the returned segments equals the total
 * co-played seconds. Returns an empty array when the sessions never overlap.
 *
 * Pure counterpart of the set-based SQL in {@link recomputeCoplayWindow}; used
 * to unit-test the overlap math without a database.
 */
export function coplayOverlapByDay(
  a: CoplaySessionInput,
  b: CoplaySessionInput,
): { day: string; seconds: number }[] {
  const startMs = Math.max(a.connectedAt.getTime(), b.connectedAt.getTime());
  const endMs = Math.min(a.endAt.getTime(), b.endAt.getTime());
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  return splitSessionSecondsByUtcDay(new Date(startMs), new Date(endMs));
}

export interface RecomputeCoplayInput {
  /** Inclusive first UTC day (YYYY-MM-DD) whose buckets are rebuilt. */
  fromDay: string;
  /** Inclusive last UTC day (YYYY-MM-DD) whose buckets are rebuilt. */
  toDay: string;
  now?: Date;
}

/**
 * Rebuild the `player_coplay` daily buckets for every day in `[fromDay, toDay]`.
 *
 * For each unordered pair of players (`player_a_id < player_b_id`) that shared a
 * server during the window, the simultaneous-presence overlap of their sessions
 * is clipped to each UTC day and summed, and the number of overlapping session
 * pairs touching the day is counted. The affected day range is deleted first, so
 * the operation is idempotent: recomputing a single day (the nightly increment)
 * yields exactly the same rows as a full-window rebuild.
 *
 * @returns the number of `player_coplay` rows written.
 */
export async function recomputeCoplayWindow(
  sql: postgres.Sql,
  input: RecomputeCoplayInput,
): Promise<number> {
  const now = input.now ?? new Date();
  const fromDayNumber = dayNumberFromKey(input.fromDay);
  const toDayNumber = dayNumberFromKey(input.toDay);
  if (toDayNumber < fromDayNumber) return 0;

  const windowStartEpoch = fromDayNumber * DAY_SECONDS;
  const windowEndEpoch = (toDayNumber + 1) * DAY_SECONDS;

  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM player_coplay
      WHERE window_start >= ${input.fromDay}::date AND window_start <= ${input.toDay}::date
    `;

    const inserted = await tx`
      INSERT INTO player_coplay
        (player_a_id, player_b_id, server_id, window_start, overlap_seconds, shared_session_count)
      SELECT
        seg.player_a_id,
        seg.player_b_id,
        seg.server_id,
        (to_timestamp(seg.day_number * ${DAY_SECONDS}) AT TIME ZONE 'UTC')::date,
        SUM(seg.seconds)::bigint,
        COUNT(*)::int
      FROM (
        SELECT
          pairs.player_a_id,
          pairs.player_b_id,
          pairs.server_id,
          gd.day_number,
          (
            LEAST(pairs.ov_end, (gd.day_number + 1) * ${DAY_SECONDS})
            - GREATEST(pairs.ov_start, gd.day_number * ${DAY_SECONDS})
          )::int AS seconds
        FROM (
          SELECT
            sa.player_id AS player_a_id,
            sb.player_id AS player_b_id,
            sa.server_id AS server_id,
            GREATEST(
              EXTRACT(EPOCH FROM sa.connected_at),
              EXTRACT(EPOCH FROM sb.connected_at)
            ) AS ov_start,
            LEAST(
              EXTRACT(EPOCH FROM COALESCE(sa.disconnected_at, ${now}::timestamptz)),
              EXTRACT(EPOCH FROM COALESCE(sb.disconnected_at, ${now}::timestamptz))
            ) AS ov_end
          FROM player_sessions sa
          JOIN player_sessions sb
            ON sa.server_id = sb.server_id
           AND sa.player_id < sb.player_id
           AND sa.connected_at < COALESCE(sb.disconnected_at, ${now}::timestamptz)
           AND sb.connected_at < COALESCE(sa.disconnected_at, ${now}::timestamptz)
          WHERE sa.connected_at < to_timestamp(${windowEndEpoch})
            AND COALESCE(sa.disconnected_at, ${now}::timestamptz) > to_timestamp(${windowStartEpoch})
            AND sb.connected_at < to_timestamp(${windowEndEpoch})
            AND COALESCE(sb.disconnected_at, ${now}::timestamptz) > to_timestamp(${windowStartEpoch})
        ) pairs
        CROSS JOIN LATERAL generate_series(
          FLOOR(pairs.ov_start / ${DAY_SECONDS})::bigint,
          FLOOR(pairs.ov_end / ${DAY_SECONDS})::bigint
        ) AS gd(day_number)
        WHERE pairs.ov_end > pairs.ov_start
          AND gd.day_number BETWEEN ${fromDayNumber} AND ${toDayNumber}
      ) seg
      WHERE seg.seconds > 0
      GROUP BY seg.player_a_id, seg.player_b_id, seg.server_id, seg.day_number
      RETURNING player_a_id
    `;

    return inserted.length;
  });
}

/**
 * Recompute the co-play buckets for the two most recent UTC days (yesterday and
 * today). Yesterday is the day the nightly cron settles; today is included so an
 * in-progress day is kept fresh. Idempotent — safe to run on every worker tick.
 */
export function recentCoplayWindow(now: Date = new Date()): { fromDay: string; toDay: string } {
  return {
    fromDay: utcDayKey(new Date(now.getTime() - DAY_MS)),
    toDay: utcDayKey(now),
  };
}

/**
 * Full rebuild of the co-play graph across every day that has session data.
 * Intended for the administrative "rebuild" command, not the nightly cron.
 *
 * @returns the number of `player_coplay` rows written.
 */
export async function recomputeCoplayForAllSessions(
  sql: postgres.Sql,
  now: Date = new Date(),
): Promise<number> {
  const [range] = await sql<{ min_at: Date | null; max_at: Date | null }[]>`
    SELECT MIN(connected_at) AS min_at,
           MAX(COALESCE(disconnected_at, ${now}::timestamptz)) AS max_at
    FROM player_sessions
  `;
  if (!range?.min_at || !range?.max_at) return 0;
  return recomputeCoplayWindow(sql, {
    fromDay: utcDayKey(new Date(range.min_at)),
    toDay: utcDayKey(new Date(range.max_at)),
    now,
  });
}
