/**
 * Clan statistics: the query-window contract (`from`/`to` days, bounds, range
 * limit) and the aggregation of presence, primetime and combat numbers for a
 * clan's current roster. Used by `routes/clans.ts`.
 */

import type { DatabaseClient } from '@squad/db';
import { computeKdRatio, computePrimetime } from '@squad/db';
import {
  clanMembers,
  playerDailyPresence,
  playerStatPeriods,
  players,
  servers,
} from '@squad/db/schema';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isCalendarDay } from './calendar-day.js';

const STATS_DAY_MS = 86_400_000;
const STATS_DEFAULT_RANGE_DAYS = 30;
const STATS_TOP_MEMBERS_LIMIT = 10;
/** Longest inclusive `from`..`to` span (in days) a clan stats request may ask for. */
const STATS_MAX_RANGE_DAYS = 366;
/**
 * Bounds on any day a clan stats window may name. Nothing the panel records
 * predates the lower one, and the upper one keeps every derived instant (the
 * window end plus one day, the default 30-day lookback) inside four-digit
 * years that both `Date#toISOString` and Postgres round-trip.
 */
const STATS_MIN_DAY = '2000-01-01';
const STATS_MAX_DAY = '2999-12-31';

/** True when `day` is a real `YYYY-MM-DD` calendar day (rejects e.g. `2024-13-45`). */
const dayStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => isCalendarDay(day) && day >= STATS_MIN_DAY && day <= STATS_MAX_DAY, {
    message: `must be a calendar day between ${STATS_MIN_DAY} and ${STATS_MAX_DAY}`,
  });

export const statsQuery = z.object({
  from: dayStringSchema.optional(),
  to: dayStringSchema.optional(),
});
export const statsExportQuery = z.object({
  from: dayStringSchema.optional(),
  to: dayStringSchema.optional(),
  format: z.literal('csv').default('csv'),
});

function subtractDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) - days * STATS_DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolves the inclusive [fromDay, toDay] window for clan stats, defaulting to
 * the trailing 30 days. Returns `null` (answered as 400 `invalid_range`) when
 * the window is inverted or spans more than {@link STATS_MAX_RANGE_DAYS} days:
 * every day in the window becomes a chart point, so an unbounded span is an
 * unbounded response (#9).
 */
export function resolveStatsWindow(
  from: string | undefined,
  to: string | undefined,
): { fromDay: string; toDay: string } | null {
  const toDay = to ?? new Date().toISOString().slice(0, 10);
  const fromDay = from ?? subtractDays(toDay, STATS_DEFAULT_RANGE_DAYS - 1);
  if (fromDay > toDay) return null;
  if (statsWindowDayCount(fromDay, toDay) > STATS_MAX_RANGE_DAYS) return null;
  return { fromDay, toDay };
}

/** Number of days in the inclusive [fromDay, toDay] window (0 when inverted). */
function statsWindowDayCount(fromDay: string, toDay: string): number {
  const spanMs = Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`);
  return Math.max(Math.round(spanMs / STATS_DAY_MS) + 1, 0);
}

/**
 * Lists every `YYYY-MM-DD` day in the inclusive window. The walk is driven by
 * the epoch-millisecond day count, so it always terminates — stepping a date
 * *string* past `9999-12-31` yields `+010000-01`, which sorts before it and
 * once looped forever (#9).
 */
function statsWindowDays(fromDay: string, toDay: string): string[] {
  const startMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  return Array.from({ length: statsWindowDayCount(fromDay, toDay) }, (_, index) =>
    new Date(startMs + index * STATS_DAY_MS).toISOString().slice(0, 10),
  );
}

interface ClanStatsChartPoint {
  day: string;
  online_seconds: number;
  boost_seconds: number;
}

interface ClanStatsServerTotal {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  online_seconds: number;
}

interface ClanStatsCombatMember {
  player_id: string;
  canonical_name: string;
  kills: number;
  deaths: number;
  revives: number;
  kd: number;
}

interface ClanStatsPayload {
  clan_id: string;
  from: string;
  to: string;
  roster_size: number;
  chart: ClanStatsChartPoint[];
  totals: {
    online_seconds: number;
    boost_seconds: number;
    primary_server: ClanStatsServerTotal | null;
  };
  primetime: {
    total_seconds: number;
    histogram: number[];
    rolling_average: number[];
    range: {
      label: string;
      start_minutes: number;
      end_minutes: number;
      start_hour: number;
      end_hour: number;
    } | null;
  };
  combat: {
    kills: number;
    deaths: number;
    revives: number;
    kd: number;
    top: ClanStatsCombatMember[];
  };
}

function emptyClanStatsPayload(clanId: string, fromDay: string, toDay: string): ClanStatsPayload {
  const chart: ClanStatsChartPoint[] = statsWindowDays(fromDay, toDay).map((day) => ({
    day,
    online_seconds: 0,
    boost_seconds: 0,
  }));
  return {
    clan_id: clanId,
    from: fromDay,
    to: toDay,
    roster_size: 0,
    chart,
    totals: { online_seconds: 0, boost_seconds: 0, primary_server: null },
    primetime: {
      total_seconds: 0,
      histogram: new Array(24).fill(0),
      rolling_average: new Array(24).fill(0),
      range: null,
    },
    combat: { kills: 0, deaths: 0, revives: 0, kd: 0, top: [] },
  };
}

/**
 * Seconds the clan's current roster spent online per UTC hour of day over
 * [windowStart, windowEnd): the SQL port of `bucketSessionsByLocalHour`
 * with offset 0 (a session is clipped to the window, an open session runs
 * to the window end, and each session-hour slice is floored to whole
 * seconds). Aggregating in Postgres covers every session of the window;
 * the handler used to load at most the oldest 5000 into Node, which
 * silently dropped a busy clan's recent activity (audit #126).
 */
async function primetimeHistogram(
  db: DatabaseClient,
  clanId: string,
  windowStart: string,
  windowEnd: string,
): Promise<number[]> {
  const rows = (await db.execute(sql`
    SELECT (slice.bucket % 24)::int AS hour,
           SUM(FLOOR(LEAST(s.hi, (slice.bucket + 1) * 3600) - GREATEST(s.lo, slice.bucket * 3600)))::bigint AS seconds
    FROM (
      SELECT EXTRACT(EPOCH FROM GREATEST(ps.connected_at, ${windowStart}::timestamptz)) AS lo,
             EXTRACT(EPOCH FROM LEAST(COALESCE(ps.disconnected_at, ${windowEnd}::timestamptz), ${windowEnd}::timestamptz)) AS hi
      FROM player_sessions ps
      WHERE ps.player_id IN (SELECT cm.player_id FROM clan_members cm WHERE cm.clan_id = ${clanId})
        AND ps.connected_at < ${windowEnd}::timestamptz
        AND (ps.disconnected_at IS NULL OR ps.disconnected_at > ${windowStart}::timestamptz)
    ) s
    CROSS JOIN LATERAL generate_series(
      FLOOR(s.lo / 3600)::bigint,
      CEIL(s.hi / 3600)::bigint - 1
    ) AS slice(bucket)
    WHERE s.hi > s.lo
    GROUP BY 1
  `)) as unknown as Array<{ hour: number; seconds: string | number }>;
  const histogram = new Array<number>(24).fill(0);
  for (const row of rows) histogram[row.hour] = Number(row.seconds);
  return histogram;
}

/**
 * Aggregates presence, primetime, and combat stats for a clan's current roster over
 * an inclusive [fromDay, toDay] window. Returns a zeroed payload when the roster is empty.
 */
export async function computeClanStats(
  db: DatabaseClient,
  clanId: string,
  fromDay: string,
  toDay: string,
): Promise<ClanStatsPayload> {
  const rosterRows = await db
    .select({ playerId: clanMembers.playerId })
    .from(clanMembers)
    .where(eq(clanMembers.clanId, clanId));
  const roster = rosterRows.map((row) => row.playerId);

  if (roster.length === 0) {
    return emptyClanStatsPayload(clanId, fromDay, toDay);
  }

  const presenceRows = await db
    .select({
      day: playerDailyPresence.day,
      serverId: playerDailyPresence.serverId,
      serverName: servers.displayName,
      serverSlug: servers.slug,
      online: sql<number>`COALESCE(SUM(${playerDailyPresence.onlineSeconds}), 0)::int`,
      boost: sql<number>`COALESCE(SUM(${playerDailyPresence.boostSeconds}), 0)::int`,
    })
    .from(playerDailyPresence)
    .leftJoin(servers, eq(servers.id, playerDailyPresence.serverId))
    .where(
      and(
        inArray(playerDailyPresence.playerId, roster),
        gte(playerDailyPresence.day, fromDay),
        lte(playerDailyPresence.day, toDay),
      ),
    )
    .groupBy(
      playerDailyPresence.day,
      playerDailyPresence.serverId,
      servers.displayName,
      servers.slug,
    )
    .orderBy(asc(playerDailyPresence.day));

  const chartByDay = new Map<string, { online: number; boost: number }>();
  for (const day of statsWindowDays(fromDay, toDay)) {
    chartByDay.set(day, { online: 0, boost: 0 });
  }
  const serverTotals = new Map<string, ClanStatsServerTotal>();
  let onlineTotal = 0;
  let boostTotal = 0;
  for (const row of presenceRows) {
    const dayEntry = chartByDay.get(row.day);
    if (dayEntry) {
      dayEntry.online += row.online;
      dayEntry.boost += row.boost;
    }
    onlineTotal += row.online;
    boostTotal += row.boost;

    const existingServer = serverTotals.get(row.serverId);
    if (existingServer) {
      existingServer.online_seconds += row.online;
    } else {
      serverTotals.set(row.serverId, {
        server_id: row.serverId,
        server_name: row.serverName,
        server_slug: row.serverSlug,
        online_seconds: row.online,
      });
    }
  }
  const chart: ClanStatsChartPoint[] = Array.from(chartByDay.entries()).map(([day, sums]) => ({
    day,
    online_seconds: sums.online,
    boost_seconds: sums.boost,
  }));
  const primaryServer =
    Array.from(serverTotals.values()).sort((a, b) => b.online_seconds - a.online_seconds)[0] ??
    null;

  const combatRows = await db
    .select({
      playerId: playerStatPeriods.playerId,
      canonicalName: players.canonicalName,
      kills: sql<number>`COALESCE(SUM(${playerStatPeriods.kills}), 0)::int`,
      deaths: sql<number>`COALESCE(SUM(${playerStatPeriods.deaths}), 0)::int`,
      revives: sql<number>`COALESCE(SUM(${playerStatPeriods.revives}), 0)::int`,
    })
    .from(playerStatPeriods)
    .innerJoin(players, eq(players.id, playerStatPeriods.playerId))
    .where(
      and(
        inArray(playerStatPeriods.playerId, roster),
        eq(playerStatPeriods.periodType, 'day'),
        isNull(playerStatPeriods.serverId),
        gte(playerStatPeriods.periodStart, fromDay),
        lte(playerStatPeriods.periodStart, toDay),
      ),
    )
    .groupBy(playerStatPeriods.playerId, players.canonicalName);

  let killsTotal = 0;
  let deathsTotal = 0;
  let revivesTotal = 0;
  const combatMembers: ClanStatsCombatMember[] = combatRows.map((row) => {
    killsTotal += row.kills;
    deathsTotal += row.deaths;
    revivesTotal += row.revives;
    return {
      player_id: row.playerId,
      canonical_name: row.canonicalName,
      kills: row.kills,
      deaths: row.deaths,
      revives: row.revives,
      kd: computeKdRatio(row.kills, row.deaths),
    };
  });
  combatMembers.sort((a, b) => b.kills - a.kills);
  const top = combatMembers.slice(0, STATS_TOP_MEMBERS_LIMIT);

  const windowStartMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  const windowEndMs = Date.parse(`${toDay}T00:00:00.000Z`) + STATS_DAY_MS;
  const histogram = await primetimeHistogram(
    db,
    clanId,
    new Date(windowStartMs).toISOString(),
    new Date(windowEndMs).toISOString(),
  );
  const primetimeResult = computePrimetime(histogram);

  return {
    clan_id: clanId,
    from: fromDay,
    to: toDay,
    roster_size: roster.length,
    chart,
    totals: {
      online_seconds: onlineTotal,
      boost_seconds: boostTotal,
      primary_server: primaryServer,
    },
    primetime: {
      total_seconds: primetimeResult.totalSeconds,
      histogram: primetimeResult.histogram,
      rolling_average: primetimeResult.rollingAverage.map((value) => Math.round(value)),
      range: primetimeResult.range
        ? {
            label: primetimeResult.range.label,
            start_minutes: primetimeResult.range.startMinutes,
            end_minutes: primetimeResult.range.endMinutes,
            start_hour: primetimeResult.range.startHour,
            end_hour: primetimeResult.range.endHour,
          }
        : null,
    },
    combat: {
      kills: killsTotal,
      deaths: deathsTotal,
      revives: revivesTotal,
      kd: computeKdRatio(killsTotal, deathsTotal),
      top,
    },
  };
}
