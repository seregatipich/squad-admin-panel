import type postgres from 'postgres';
import { SESSION_PRUNE_LOOKBACK_SECONDS } from '../session-window.js';

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayNumberFromKey(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

export interface DaySegment {
  day: string;
  seconds: number;
}

export function splitSessionSecondsByUtcDay(connectedAt: Date, endAt: Date): DaySegment[] {
  const startMs = connectedAt.getTime();
  const endMs = endAt.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const segments: DaySegment[] = [];
  let cursorMs = startMs;
  let carriedOffsetSeconds = 0;
  while (cursorMs < endMs) {
    const nextMidnightMs = (Math.floor(cursorMs / DAY_MS) + 1) * DAY_MS;
    const segmentEndMs = Math.min(nextMidnightMs, endMs);
    const offsetSeconds = Math.floor((segmentEndMs - startMs) / 1000);
    const seconds = offsetSeconds - carriedOffsetSeconds;
    if (seconds > 0) {
      segments.push({ day: utcDayKey(new Date(cursorMs)), seconds });
    }
    carriedOffsetSeconds = offsetSeconds;
    cursorMs = segmentEndMs;
  }
  return segments;
}

export interface RecomputeDailyPresenceInput {
  fromDay: string;
  toDay: string;
  now?: Date;
}

export async function recomputeDailyPresence(
  sql: postgres.Sql,
  input: RecomputeDailyPresenceInput,
): Promise<number> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const fromDayNumber = dayNumberFromKey(input.fromDay);
  const toDayNumber = dayNumberFromKey(input.toDay);
  if (toDayNumber < fromDayNumber) return 0;

  const windowStartEpoch = fromDayNumber * DAY_SECONDS;
  const windowEndEpoch = (toDayNumber + 1) * DAY_SECONDS;

  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM player_daily_presence
      WHERE day >= ${input.fromDay}::date AND day <= ${input.toDay}::date
    `;

    const inserted = await tx`
      INSERT INTO player_daily_presence
        (player_id, server_id, day, online_seconds, boost_seconds, queue_seconds, seed_seconds, session_count)
      SELECT
        seg.player_id,
        seg.server_id,
        (to_timestamp(seg.day_number * ${DAY_SECONDS}) AT TIME ZONE 'UTC')::date,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'online'), 0)::int,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'boost'), 0)::int,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'queue'), 0)::int,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'seed'), 0)::int,
        COUNT(DISTINCT seg.session_id)::int
      FROM (
        SELECT
          ps.player_id,
          ps.server_id,
          ps.id AS session_id,
          ps.mode,
          gd.day_number,
          (
            FLOOR(
              LEAST(
                EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${nowIso}::timestamptz)),
                (gd.day_number + 1) * ${DAY_SECONDS}
              ) - EXTRACT(EPOCH FROM ps.connected_at)
            )
            - FLOOR(
              GREATEST(
                EXTRACT(EPOCH FROM ps.connected_at),
                gd.day_number * ${DAY_SECONDS}
              ) - EXTRACT(EPOCH FROM ps.connected_at)
            )
          )::int AS seconds
        FROM player_sessions ps
        CROSS JOIN LATERAL generate_series(
          FLOOR(EXTRACT(EPOCH FROM ps.connected_at) / ${DAY_SECONDS})::bigint,
          FLOOR(EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${nowIso}::timestamptz)) / ${DAY_SECONDS})::bigint
        ) AS gd(day_number)
        WHERE ps.connected_at < to_timestamp(${windowEndEpoch})
          AND COALESCE(ps.disconnected_at, ${nowIso}::timestamptz) > to_timestamp(${windowStartEpoch})
          AND (ps.connected_at >= to_timestamp(${windowStartEpoch - SESSION_PRUNE_LOOKBACK_SECONDS})
               OR ps.disconnected_at IS NULL)
          AND gd.day_number BETWEEN ${fromDayNumber} AND ${toDayNumber}
      ) seg
      WHERE seg.seconds > 0
      GROUP BY seg.player_id, seg.server_id, seg.day_number
      RETURNING player_id
    `;

    await tx`
      UPDATE players p
      SET total_time_played_seconds = totals.total,
          updated_at = now()
      FROM (
        SELECT touched.player_id, COALESCE(SUM(s.duration_seconds), 0)::bigint AS total
        FROM (
          SELECT DISTINCT ps.player_id
          FROM player_sessions ps
          WHERE ps.connected_at < to_timestamp(${windowEndEpoch})
            AND COALESCE(ps.disconnected_at, ${nowIso}::timestamptz) > to_timestamp(${windowStartEpoch})
            AND (ps.connected_at >= to_timestamp(${windowStartEpoch - SESSION_PRUNE_LOOKBACK_SECONDS})
                 OR ps.disconnected_at IS NULL)
        ) touched
        LEFT JOIN player_sessions s
          ON s.player_id = touched.player_id AND s.duration_seconds IS NOT NULL
        GROUP BY touched.player_id
      ) totals
      WHERE p.id = totals.player_id
        AND p.total_time_played_seconds IS DISTINCT FROM totals.total
    `;

    return inserted.length;
  });
}

/**
 * Full-history backfill of `player_daily_presence`: recomputes every day from
 * the earliest session to `now` through {@link recomputeDailyPresence}, the
 * single source of truth for the aggregation. Not called by the presence-daily
 * worker (it recomputes a rolling window); it is the operator/test entry point
 * for rebuilding the table from `player_sessions`.
 */
export async function recomputeDailyPresenceForAllSessions(
  sql: postgres.Sql,
  now: Date = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const [range] = await sql<{ min_at: Date | null; max_at: Date | null }[]>`
    SELECT MIN(connected_at) AS min_at,
           MAX(COALESCE(disconnected_at, ${nowIso}::timestamptz)) AS max_at
    FROM player_sessions
  `;
  if (!range?.min_at || !range?.max_at) return 0;
  return recomputeDailyPresence(sql, {
    fromDay: utcDayKey(new Date(range.min_at)),
    toDay: utcDayKey(new Date(range.max_at)),
    now,
  });
}

export function recentPresenceWindow(now: Date = new Date()): {
  fromDay: string;
  toDay: string;
} {
  const today = utcDayKey(now);
  const yesterday = utcDayKey(new Date(now.getTime() - DAY_MS));
  return { fromDay: yesterday, toDay: today };
}
