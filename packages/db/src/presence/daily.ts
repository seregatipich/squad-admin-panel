import type postgres from 'postgres';
import type { SessionMode } from '../schema/player-sessions.js';

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

export interface SessionInput {
  connectedAt: Date;
  endAt: Date;
  mode?: SessionMode;
}

export interface DailyBucket {
  day: string;
  onlineSeconds: number;
  boostSeconds: number;
  queueSeconds: number;
  sessionCount: number;
}

export function aggregateSessionsByDay(sessions: SessionInput[]): DailyBucket[] {
  const byDay = new Map<string, DailyBucket>();
  for (const session of sessions) {
    const mode = session.mode ?? 'online';
    for (const segment of splitSessionSecondsByUtcDay(session.connectedAt, session.endAt)) {
      let bucket = byDay.get(segment.day);
      if (!bucket) {
        bucket = {
          day: segment.day,
          onlineSeconds: 0,
          boostSeconds: 0,
          queueSeconds: 0,
          sessionCount: 0,
        };
        byDay.set(segment.day, bucket);
      }
      if (mode === 'boost') bucket.boostSeconds += segment.seconds;
      else if (mode === 'queue') bucket.queueSeconds += segment.seconds;
      else bucket.onlineSeconds += segment.seconds;
      bucket.sessionCount += 1;
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
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
        (player_id, server_id, day, online_seconds, boost_seconds, queue_seconds, session_count)
      SELECT
        seg.player_id,
        seg.server_id,
        (to_timestamp(seg.day_number * ${DAY_SECONDS}) AT TIME ZONE 'UTC')::date,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'online'), 0)::int,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'boost'), 0)::int,
        COALESCE(SUM(seg.seconds) FILTER (WHERE seg.mode = 'queue'), 0)::int,
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
                EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${now}::timestamptz)),
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
          FLOOR(EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${now}::timestamptz)) / ${DAY_SECONDS})::bigint
        ) AS gd(day_number)
        WHERE ps.connected_at < to_timestamp(${windowEndEpoch})
          AND COALESCE(ps.disconnected_at, ${now}::timestamptz) > to_timestamp(${windowStartEpoch})
          AND gd.day_number BETWEEN ${fromDayNumber} AND ${toDayNumber}
      ) seg
      WHERE seg.seconds > 0
      GROUP BY seg.player_id, seg.server_id, seg.day_number
      RETURNING player_id
    `;

    await tx`
      UPDATE players p
      SET total_time_played_seconds = COALESCE((
            SELECT SUM(s.duration_seconds)
            FROM player_sessions s
            WHERE s.player_id = p.id AND s.duration_seconds IS NOT NULL
          ), 0),
          updated_at = now()
      WHERE p.id IN (
        SELECT DISTINCT ps.player_id
        FROM player_sessions ps
        WHERE ps.connected_at < to_timestamp(${windowEndEpoch})
          AND COALESCE(ps.disconnected_at, ${now}::timestamptz) > to_timestamp(${windowStartEpoch})
      )
    `;

    return inserted.length;
  });
}

export async function recomputeDailyPresenceForAllSessions(
  sql: postgres.Sql,
  now: Date = new Date(),
): Promise<number> {
  const [range] = await sql<{ min_at: Date | null; max_at: Date | null }[]>`
    SELECT MIN(connected_at) AS min_at,
           MAX(COALESCE(disconnected_at, ${now}::timestamptz)) AS max_at
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
