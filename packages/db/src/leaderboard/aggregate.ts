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
}

export async function recomputeLeaderboardPeriod(
  sql: postgres.Sql,
  input: RecomputePeriodInput,
): Promise<number> {
  const { periodType, periodStart } = input;
  const range = periodDayRange(periodType, periodStart);

  const presenceFilter = range
    ? sql`WHERE day >= ${range.fromDay}::date AND day <= ${range.toDay}::date`
    : sql``;
  const matchesFilter = range
    ? sql`WHERE m.started_at >= ${range.fromDay}::date
        AND m.started_at < (${range.toDay}::date + INTERVAL '1 day')`
    : sql``;

  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM player_stat_periods
      WHERE period_type = ${periodType} AND period_start = ${periodStart}::date
    `;

    const inserted = await tx`
      WITH presence_agg AS (
        SELECT player_id, server_id,
               COALESCE(SUM(online_seconds), 0)::int AS online_seconds
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
      combined AS (
        SELECT
          COALESCE(p.player_id, mm.player_id) AS player_id,
          COALESCE(p.server_id, mm.server_id) AS server_id,
          COALESCE(p.online_seconds, 0) AS online_seconds,
          COALESCE(mm.matches_played, 0) AS matches_played
        FROM presence_agg p
        FULL OUTER JOIN matches_agg mm
          ON p.player_id = mm.player_id AND p.server_id = mm.server_id
      ),
      per_server AS (
        SELECT player_id, server_id, online_seconds, matches_played
        FROM combined
      ),
      rollup AS (
        SELECT player_id, NULL::uuid AS server_id,
               SUM(online_seconds)::int AS online_seconds,
               SUM(matches_played)::int AS matches_played
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
         online_seconds, seeding_seconds, kills, deaths, teamkills, revives, kd_ratio, matches_played)
      SELECT
        player_id,
        server_id,
        ${periodType},
        ${periodStart}::date,
        online_seconds,
        0,
        0,
        0,
        0,
        0,
        0,
        matches_played
      FROM all_rows
      RETURNING player_id
    `;

    return inserted.length;
  });
}

export async function recomputeLeaderboardPeriods(
  sql: postgres.Sql,
  periods: PeriodDescriptor[],
): Promise<number> {
  let total = 0;
  for (const period of periods) {
    total += await recomputeLeaderboardPeriod(sql, period);
  }
  return total;
}
