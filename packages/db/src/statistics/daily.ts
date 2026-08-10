import type postgres from 'postgres';

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

function dayNumberFromKey(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

export interface RecomputeServerDailyStatsInput {
  /** Inclusive first UTC day (`YYYY-MM-DD`) to rebuild. */
  fromDay: string;
  /** Inclusive last UTC day (`YYYY-MM-DD`) to rebuild. */
  toDay: string;
  /** Clock used to close still-open sessions and to size the in-progress day. */
  now?: Date;
}

/**
 * Rebuilds `server_daily_stats` for every server across `fromDay..toDay`
 * (inclusive, UTC days) — the materialised rollup behind `GET /api/v1/statistics`.
 *
 * Semantics:
 * - **Full replacement of the window.** Rows inside the window are deleted and
 *   rewritten in one transaction, so the function is idempotent and safe to run
 *   on every worker tick. Days outside the window are never touched.
 * - **One row per server per day**, including days with no activity, so the
 *   dashboard's stacked series need no gap filling.
 * - **Population comes from `player_sessions` only.** `player_daily_presence`
 *   stores summed seconds without instantaneous values, so peaks cannot be
 *   derived from it; computing both seconds and peaks from the same sessions
 *   keeps the row internally consistent and independent of recompute ordering.
 *   `peak_online`/`peak_admins` are exact maxima from an interval sweep (+1 at
 *   each session start, −1 at each end, running sum), not a sampled estimate;
 *   ends are ordered before starts at an identical instant so a reconnect at
 *   the same timestamp is not double-counted.
 * - **Averages are time-weighted over the elapsed part of the day**, i.e.
 *   `seconds / (min(day_end, now) − day_start)`, so the day in progress is not
 *   diluted by hours that have not happened yet.
 * - **New players** are attributed to the server of their earliest session on
 *   the day `players.first_seen_at` falls on (the day of their first
 *   `player.connected`). A player first seen without any session that day is
 *   counted nowhere, since no server can be attributed.
 * - **Punishments** come from `moderation_actions`; rows with a NULL
 *   `server_id` are network-wide and belong to no server column.
 *
 * @param sql Postgres client used for the whole transaction.
 * @param input Window to rebuild plus the reference clock.
 * @returns Number of rows written (0 when `toDay` precedes `fromDay`).
 */
export async function recomputeServerDailyStats(
  sql: postgres.Sql,
  input: RecomputeServerDailyStatsInput,
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
      DELETE FROM server_daily_stats
      WHERE day >= ${input.fromDay}::date AND day <= ${input.toDay}::date
    `;

    const inserted = await tx`
      WITH days AS (
        SELECT gs AS day_number
        FROM generate_series(${fromDayNumber}::bigint, ${toDayNumber}::bigint) AS gs
      ),
      grid AS (
        SELECT s.id AS server_id, d.day_number
        FROM servers s CROSS JOIN days d
      ),
      spans AS (
        SELECT
          d.day_number,
          GREATEST(
            1,
            FLOOR(
              LEAST(EXTRACT(EPOCH FROM ${nowIso}::timestamptz), (d.day_number + 1) * ${DAY_SECONDS})
              - d.day_number * ${DAY_SECONDS}
            )
          )::bigint AS span_seconds
        FROM days d
      ),
      seg AS (
        SELECT
          ps.server_id,
          gd.day_number,
          ps.mode,
          EXISTS (
            SELECT 1
            FROM players p
            JOIN role_squad_permissions rsp ON rsp.role_id = p.role_id
            WHERE p.id = ps.player_id
          ) AS is_admin,
          GREATEST(
            EXTRACT(EPOCH FROM ps.connected_at),
            gd.day_number * ${DAY_SECONDS}
          ) AS seg_start,
          LEAST(
            EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${nowIso}::timestamptz)),
            (gd.day_number + 1) * ${DAY_SECONDS}
          ) AS seg_end
        FROM player_sessions ps
        CROSS JOIN LATERAL generate_series(
          FLOOR(EXTRACT(EPOCH FROM ps.connected_at) / ${DAY_SECONDS})::bigint,
          FLOOR(EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, ${nowIso}::timestamptz)) / ${DAY_SECONDS})::bigint
        ) AS gd(day_number)
        WHERE ps.connected_at < to_timestamp(${windowEndEpoch})
          AND COALESCE(ps.disconnected_at, ${nowIso}::timestamptz) > to_timestamp(${windowStartEpoch})
          AND gd.day_number BETWEEN ${fromDayNumber} AND ${toDayNumber}
      ),
      seconds AS (
        SELECT
          server_id,
          day_number,
          COALESCE(SUM(FLOOR(seg_end - seg_start)) FILTER (WHERE mode = 'online'), 0)::bigint AS online_seconds,
          COALESCE(SUM(FLOOR(seg_end - seg_start)) FILTER (WHERE mode = 'queue'), 0)::bigint AS queue_seconds,
          COALESCE(SUM(FLOOR(seg_end - seg_start)) FILTER (WHERE mode = 'online' AND is_admin), 0)::bigint AS admin_seconds
        FROM seg
        WHERE seg_end > seg_start
        GROUP BY server_id, day_number
      ),
      sweep AS (
        SELECT server_id, day_number, seg_start AS at, 1 AS delta, is_admin
        FROM seg WHERE mode = 'online' AND seg_end > seg_start
        UNION ALL
        SELECT server_id, day_number, seg_end AS at, -1 AS delta, is_admin
        FROM seg WHERE mode = 'online' AND seg_end > seg_start
      ),
      running AS (
        SELECT
          server_id,
          day_number,
          SUM(delta) OVER (
            PARTITION BY server_id, day_number ORDER BY at, delta
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS concurrent,
          SUM(CASE WHEN is_admin THEN delta ELSE 0 END) OVER (
            PARTITION BY server_id, day_number ORDER BY at, delta
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS admin_concurrent
        FROM sweep
      ),
      peaks AS (
        SELECT
          server_id,
          day_number,
          MAX(concurrent)::int AS peak_online,
          MAX(admin_concurrent)::int AS peak_admins
        FROM running
        GROUP BY server_id, day_number
      ),
      window_matches AS (
        SELECT
          m.server_id,
          FLOOR(EXTRACT(EPOCH FROM m.started_at) / ${DAY_SECONDS})::bigint AS day_number,
          COALESCE(NULLIF(m.game_mode, ''), 'unknown') AS game_mode,
          m.map,
          m.is_seed
        FROM matches m
        WHERE m.started_at >= to_timestamp(${windowStartEpoch})
          AND m.started_at < to_timestamp(${windowEndEpoch})
      ),
      match_counts AS (
        SELECT server_id, day_number, COUNT(*)::int AS matches
        FROM window_matches GROUP BY server_id, day_number
      ),
      mode_counts AS (
        SELECT server_id, day_number, game_mode, COUNT(*)::int AS n
        FROM window_matches GROUP BY server_id, day_number, game_mode
      ),
      modes AS (
        SELECT server_id, day_number, jsonb_object_agg(game_mode, n) AS modes
        FROM mode_counts GROUP BY server_id, day_number
      ),
      map_counts AS (
        SELECT server_id, day_number, map, COUNT(*)::int AS n
        FROM window_matches
        WHERE map IS NOT NULL AND is_seed = false AND game_mode <> 'Skirmish'
        GROUP BY server_id, day_number, map
      ),
      maps AS (
        SELECT server_id, day_number, jsonb_object_agg(map, n) AS maps
        FROM map_counts GROUP BY server_id, day_number
      ),
      chat AS (
        SELECT
          c.server_id,
          FLOOR(EXTRACT(EPOCH FROM c.sent_at) / ${DAY_SECONDS})::bigint AS day_number,
          COUNT(*)::int AS chat_messages
        FROM chat_messages c
        WHERE c.source = 'log'
          AND c.sent_at >= to_timestamp(${windowStartEpoch})
          AND c.sent_at < to_timestamp(${windowEndEpoch})
        GROUP BY c.server_id, day_number
      ),
      teamkills AS (
        SELECT
          e.server_id,
          FLOOR(EXTRACT(EPOCH FROM e.occurred_at) / ${DAY_SECONDS})::bigint AS day_number,
          COUNT(*)::int AS teamkills
        FROM combat_events e
        WHERE e.is_teamkill
          AND e.occurred_at >= to_timestamp(${windowStartEpoch})
          AND e.occurred_at < to_timestamp(${windowEndEpoch})
        GROUP BY e.server_id, day_number
      ),
      punishments AS (
        SELECT
          a.server_id,
          FLOOR(EXTRACT(EPOCH FROM a.created_at) / ${DAY_SECONDS})::bigint AS day_number,
          COUNT(*)::int AS punishments
        FROM moderation_actions a
        WHERE a.server_id IS NOT NULL
          AND a.created_at >= to_timestamp(${windowStartEpoch})
          AND a.created_at < to_timestamp(${windowEndEpoch})
        GROUP BY a.server_id, day_number
      ),
      first_sessions AS (
        SELECT DISTINCT ON (p.id)
          p.id AS player_id,
          FLOOR(EXTRACT(EPOCH FROM p.first_seen_at) / ${DAY_SECONDS})::bigint AS day_number,
          ps.server_id
        FROM players p
        JOIN player_sessions ps ON ps.player_id = p.id
          AND ps.connected_at >= to_timestamp(${windowStartEpoch})
          AND ps.connected_at < to_timestamp(${windowEndEpoch})
        WHERE p.first_seen_at >= to_timestamp(${windowStartEpoch})
          AND p.first_seen_at < to_timestamp(${windowEndEpoch})
        ORDER BY p.id, ps.connected_at
      ),
      new_players AS (
        SELECT server_id, day_number, COUNT(*)::int AS new_players
        FROM first_sessions GROUP BY server_id, day_number
      )
      INSERT INTO server_daily_stats
        (server_id, day, avg_online, peak_online, avg_queue, online_seconds, matches, modes, maps,
         new_players, chat_messages, teamkills, punishments, avg_admins, peak_admins, computed_at)
      SELECT
        g.server_id,
        (to_timestamp(g.day_number * ${DAY_SECONDS}) AT TIME ZONE 'UTC')::date,
        ROUND(COALESCE(sec.online_seconds, 0)::numeric / sp.span_seconds)::int,
        COALESCE(pk.peak_online, 0),
        ROUND(COALESCE(sec.queue_seconds, 0)::numeric / sp.span_seconds)::int,
        COALESCE(sec.online_seconds, 0),
        COALESCE(mc.matches, 0),
        COALESCE(md.modes, '{}'::jsonb),
        COALESCE(mp.maps, '{}'::jsonb),
        COALESCE(np.new_players, 0),
        COALESCE(ch.chat_messages, 0),
        COALESCE(tk.teamkills, 0),
        COALESCE(pu.punishments, 0),
        ROUND(COALESCE(sec.admin_seconds, 0)::numeric / sp.span_seconds)::int,
        COALESCE(pk.peak_admins, 0),
        ${nowIso}::timestamptz
      FROM grid g
      JOIN spans sp ON sp.day_number = g.day_number
      LEFT JOIN seconds sec ON sec.server_id = g.server_id AND sec.day_number = g.day_number
      LEFT JOIN peaks pk ON pk.server_id = g.server_id AND pk.day_number = g.day_number
      LEFT JOIN match_counts mc ON mc.server_id = g.server_id AND mc.day_number = g.day_number
      LEFT JOIN modes md ON md.server_id = g.server_id AND md.day_number = g.day_number
      LEFT JOIN maps mp ON mp.server_id = g.server_id AND mp.day_number = g.day_number
      LEFT JOIN chat ch ON ch.server_id = g.server_id AND ch.day_number = g.day_number
      LEFT JOIN teamkills tk ON tk.server_id = g.server_id AND tk.day_number = g.day_number
      LEFT JOIN punishments pu ON pu.server_id = g.server_id AND pu.day_number = g.day_number
      LEFT JOIN new_players np ON np.server_id = g.server_id AND np.day_number = g.day_number
      RETURNING server_id
    `;

    return inserted.length;
  });
}
