import type postgres from 'postgres';
import type { StatPeriodType } from '../schema/player-stat-periods.js';

const DAY_MS = 86_400_000;
export const ALLTIME_PERIOD_START = '1970-01-01';

export interface LeaderboardMetrics {
  onlineSeconds: number;
  seedingSeconds: number;
  kills: number;
  deaths: number;
  teamkills: number;
  revives: number;
  matchesPlayed: number;
}

export function computeKdRatio(kills: number, deaths: number): number {
  if (deaths === 0) return kills;
  return kills / deaths;
}

export function rollupServers(
  rows: LeaderboardMetrics[],
): LeaderboardMetrics & { kdRatio: number } {
  const total = rows.reduce<LeaderboardMetrics>(
    (acc, row) => ({
      onlineSeconds: acc.onlineSeconds + row.onlineSeconds,
      seedingSeconds: acc.seedingSeconds + row.seedingSeconds,
      kills: acc.kills + row.kills,
      deaths: acc.deaths + row.deaths,
      teamkills: acc.teamkills + row.teamkills,
      revives: acc.revives + row.revives,
      matchesPlayed: acc.matchesPlayed + row.matchesPlayed,
    }),
    {
      onlineSeconds: 0,
      seedingSeconds: 0,
      kills: 0,
      deaths: 0,
      teamkills: 0,
      revives: 0,
      matchesPlayed: 0,
    },
  );
  return { ...total, kdRatio: computeKdRatio(total.kills, total.deaths) };
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function isoWeekStart(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  const dow = new Date(at).getUTCDay();
  const isoOffset = dow === 0 ? 6 : dow - 1;
  return utcDayKey(new Date(at - isoOffset * DAY_MS));
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function periodStartFor(periodType: StatPeriodType, day: string): string {
  switch (periodType) {
    case 'day':
      return day;
    case 'week':
      return isoWeekStart(day);
    case 'month':
      return monthStart(day);
    case 'alltime':
      return ALLTIME_PERIOD_START;
    default:
      throw new Error(`period_type '${periodType}' has no derivable period_start`);
  }
}

export interface DayRange {
  fromDay: string;
  toDay: string;
}

export function periodDayRange(periodType: StatPeriodType, periodStart: string): DayRange | null {
  switch (periodType) {
    case 'day':
      return { fromDay: periodStart, toDay: periodStart };
    case 'week': {
      const start = Date.parse(`${periodStart}T00:00:00.000Z`);
      return { fromDay: periodStart, toDay: utcDayKey(new Date(start + 6 * DAY_MS)) };
    }
    case 'month': {
      const year = Number.parseInt(periodStart.slice(0, 4), 10);
      const month = Number.parseInt(periodStart.slice(5, 7), 10);
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        fromDay: periodStart,
        toDay: `${periodStart.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`,
      };
    }
    default:
      return null;
  }
}

export interface PeriodDescriptor {
  periodType: StatPeriodType;
  periodStart: string;
}

export function periodsToRecompute(now: Date = new Date()): PeriodDescriptor[] {
  const today = utcDayKey(now);
  const yesterday = utcDayKey(new Date(now.getTime() - DAY_MS));
  const lastWeek = utcDayKey(new Date(now.getTime() - 7 * DAY_MS));
  const lastMonth = utcDayKey(new Date(now.getTime() - 31 * DAY_MS));

  const descriptors: PeriodDescriptor[] = [
    { periodType: 'day', periodStart: periodStartFor('day', today) },
    { periodType: 'day', periodStart: periodStartFor('day', yesterday) },
    { periodType: 'week', periodStart: periodStartFor('week', today) },
    { periodType: 'week', periodStart: periodStartFor('week', lastWeek) },
    { periodType: 'month', periodStart: periodStartFor('month', today) },
    { periodType: 'month', periodStart: periodStartFor('month', lastMonth) },
    { periodType: 'alltime', periodStart: ALLTIME_PERIOD_START },
  ];

  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    const key = `${descriptor.periodType}:${descriptor.periodStart}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RecomputePeriodInput {
  periodType: StatPeriodType;
  periodStart: string;
  /**
   * Explicit day window, overriding `periodDayRange(periodType, periodStart)`.
   *
   * Required for `period_type = 'season'` (LEAD-7, #178): a season is an
   * arbitrary named interval, so its bounds cannot be derived from
   * `periodStart` the way day/week/month can. `periodDayRange` returns `null`
   * for `'season'`, which would otherwise widen the slice to all time and pull
   * in events from outside the season.
   *
   * Both ends are inclusive: presence is matched on `day`, and matches on
   * `started_at < toDay + 1 day`, so an event at 23:30 on `toDay` counts.
   */
  range?: DayRange;
}

export async function recomputeLeaderboardPeriod(
  sql: postgres.Sql,
  input: RecomputePeriodInput,
): Promise<number> {
  const { periodType, periodStart } = input;
  const range = input.range ?? periodDayRange(periodType, periodStart);

  const presenceFilter = range
    ? sql`WHERE day >= ${range.fromDay}::date AND day <= ${range.toDay}::date`
    : sql``;
  // The day bounds are UTC days everywhere else in this file (`utcDayKey`, and
  // `player_daily_presence.day`), so the match window must be anchored to UTC
  // too. Writing it as `${toDay}::date + INTERVAL '1 day'` yields a *local*
  // timestamp, which on a non-UTC Postgres session slides the window by the
  // offset and makes the presence and match halves of one period cover
  // different spans. `AT TIME ZONE 'UTC'` pins both edges.
  const matchesFilter = range
    ? sql`WHERE m.started_at >= (${range.fromDay}::date)::timestamp AT TIME ZONE 'UTC'
        AND m.started_at < (${range.toDay}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC'`
    : sql``;

  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM player_stat_periods
      WHERE period_type = ${periodType} AND period_start = ${periodStart}::date
    `;

    const inserted = await tx`
      WITH settings AS (
        SELECT
          COALESCE((SELECT k_online FROM economy_settings WHERE id = 1), 1) AS k_online,
          COALESCE((SELECT k_boost FROM economy_settings WHERE id = 1), 2) AS k_boost,
          COALESCE((SELECT k_seed FROM economy_settings WHERE id = 1), 3) AS k_seed
      ),
      presence_agg AS (
        SELECT player_id, server_id,
               COALESCE(SUM(online_seconds), 0)::int AS online_seconds,
               COALESCE(SUM(boost_seconds), 0)::int AS boost_seconds,
               COALESCE(SUM(seed_seconds), 0)::int AS seed_seconds
        FROM player_daily_presence
        ${presenceFilter}
        GROUP BY player_id, server_id
      ),
      matches_agg AS (
        SELECT mp.player_id, m.server_id,
               COUNT(DISTINCT m.id)::int AS matches_played
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        ${matchesFilter}
        GROUP BY mp.player_id, m.server_id
      ),
      combat_agg AS (
        SELECT mp.player_id, m.server_id,
               COALESCE(SUM(mp.kills), 0)::int AS kills,
               COALESCE(SUM(mp.deaths), 0)::int AS deaths,
               COALESCE(SUM(mp.teamkills), 0)::int AS teamkills,
               COALESCE(SUM(mp.revives), 0)::int AS revives
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        ${matchesFilter}
        GROUP BY mp.player_id, m.server_id
      ),
      combined AS (
        SELECT
          COALESCE(p.player_id, mm.player_id, c.player_id) AS player_id,
          COALESCE(p.server_id, mm.server_id, c.server_id) AS server_id,
          COALESCE(p.online_seconds, 0) AS online_seconds,
          COALESCE(p.boost_seconds, 0) AS boost_seconds,
          COALESCE(p.seed_seconds, 0) AS seed_seconds,
          COALESCE(mm.matches_played, 0) AS matches_played,
          COALESCE(c.kills, 0) AS kills,
          COALESCE(c.deaths, 0) AS deaths,
          COALESCE(c.teamkills, 0) AS teamkills,
          COALESCE(c.revives, 0) AS revives
        FROM presence_agg p
        FULL OUTER JOIN matches_agg mm
          ON p.player_id = mm.player_id AND p.server_id = mm.server_id
        FULL OUTER JOIN combat_agg c
          ON COALESCE(p.player_id, mm.player_id) = c.player_id
         AND COALESCE(p.server_id, mm.server_id) = c.server_id
      ),
      per_server AS (
        SELECT player_id, server_id, online_seconds, boost_seconds, seed_seconds,
               matches_played, kills, deaths, teamkills, revives
        FROM combined
      ),
      rollup AS (
        SELECT player_id, NULL::uuid AS server_id,
               SUM(online_seconds)::int AS online_seconds,
               SUM(boost_seconds)::int AS boost_seconds,
               SUM(seed_seconds)::int AS seed_seconds,
               SUM(matches_played)::int AS matches_played,
               SUM(kills)::int AS kills,
               SUM(deaths)::int AS deaths,
               SUM(teamkills)::int AS teamkills,
               SUM(revives)::int AS revives
        FROM combined
        GROUP BY player_id
      ),
      all_rows AS (
        SELECT * FROM per_server
        UNION ALL
        SELECT * FROM rollup
      )
      INSERT INTO player_stat_periods
        (player_id, server_id, period_type, period_start,
         online_seconds, seeding_seconds, kills, deaths, teamkills, revives, kd_ratio,
         matches_played, boost_seconds, bonus_points)
      SELECT
        all_rows.player_id,
        all_rows.server_id,
        ${periodType},
        ${periodStart}::date,
        all_rows.online_seconds,
        all_rows.seed_seconds,
        all_rows.kills,
        all_rows.deaths,
        all_rows.teamkills,
        all_rows.revives,
        CASE WHEN all_rows.deaths = 0 THEN all_rows.kills
             ELSE all_rows.kills::numeric / all_rows.deaths END,
        all_rows.matches_played,
        all_rows.boost_seconds,
        (settings.k_online * all_rows.online_seconds
          + settings.k_boost * all_rows.boost_seconds
          + settings.k_seed * all_rows.seed_seconds)::numeric
      FROM all_rows CROSS JOIN settings
      RETURNING player_id
    `;

    return inserted.length;
  });
}

/**
 * Recomputes several periods in sequence.
 *
 * Accepts `RecomputePeriodInput[]` rather than `PeriodDescriptor[]` so a
 * caller can mix the derived day/week/month/alltime descriptors from
 * `periodsToRecompute` with a season descriptor carrying an explicit `range`
 * (LEAD-7, #178). `PeriodDescriptor` is structurally assignable, so existing
 * callers are unaffected.
 */
export async function recomputeLeaderboardPeriods(
  sql: postgres.Sql,
  periods: RecomputePeriodInput[],
): Promise<number> {
  let total = 0;
  for (const period of periods) {
    total += await recomputeLeaderboardPeriod(sql, period);
  }
  return total;
}

/**
 * One-shot combat backfill (DOSSIER-4 #191): recomputes the `month` stat
 * periods for the last `months` calendar months (current UTC month included,
 * counting backwards), so historical `match_players` combat data lands in
 * `player_stat_periods` without waiting for the regular tick to walk past it.
 *
 * @param sql - postgres.js connection.
 * @param months - how many months to recompute; `<= 0` is a no-op.
 * @param now - clock override for tests; defaults to the current time.
 * @returns total number of `player_stat_periods` rows written.
 */
export async function backfillMonths(
  sql: postgres.Sql,
  months: number,
  now: Date = new Date(),
): Promise<number> {
  let total = 0;
  for (let i = 0; i < months; i += 1) {
    const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    total += await recomputeLeaderboardPeriod(sql, {
      periodType: 'month',
      periodStart: utcDayKey(monthDate),
    });
  }
  return total;
}
