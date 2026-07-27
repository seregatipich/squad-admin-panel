import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { escapeCsvField, MAX_WINDOW_DAYS, resolveWindow } from './analytics.js';

const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const statisticsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** CSV of server UUIDs; omitted or empty means "every server". */
  servers: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Hour-of-day bucket keys, zero-padded so they sort lexically. */
export const HOUR_KEYS: string[] = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, '0'),
);

/** ISO weekday bucket keys — `1` is Monday, `7` is Sunday. */
export const WEEKDAY_KEYS: string[] = ['1', '2', '3', '4', '5', '6', '7'];

export interface SeriesPoint {
  key: string;
  value: number;
}

/**
 * One plottable metric: a dense per-server breakdown, the stacked totals, and
 * the "Среднее / Максимум / Всего" KPI triple the dashboard prints above each
 * chart. `kpi.total` is exactly the sum of every per-server point, so a stacked
 * bar chart and its KPI can never disagree.
 */
export interface StatisticsSeries {
  by_server: Array<{ server_id: string; points: SeriesPoint[] }>;
  totals: SeriesPoint[];
  kpi: { avg: number; max: number; total: number };
}

export interface StatisticsPayload {
  from: string;
  to: string;
  days: string[];
  servers: Array<{ server_id: string; display_name: string }>;
  population: {
    avg_online: StatisticsSeries;
    peak_online: StatisticsSeries;
    avg_queue: StatisticsSeries;
    by_hour: StatisticsSeries;
    by_weekday: StatisticsSeries;
  };
  matches: {
    by_day: StatisticsSeries;
    modes: Array<{ mode: string; matches: number }>;
    maps: Array<{ map: string; matches: number }>;
  };
  community: {
    new_players: StatisticsSeries;
    chat_messages: StatisticsSeries;
    teamkills: StatisticsSeries;
  };
  moderation: {
    punishments: StatisticsSeries;
    avg_admins: StatisticsSeries;
    peak_admins: StatisticsSeries;
  };
}

/**
 * Parses the `servers` CSV into a de-duplicated list of UUIDs. Malformed
 * entries are dropped rather than rejected, matching AN-1's "clamp silently"
 * contract for bad query input.
 */
export function parseServerFilter(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (UUID_RE.test(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Lists every UTC day touched by the window, inclusive of both bounds. The
 * result is the dense x-axis every daily series is projected onto, so a day
 * with no rollup row still gets a zero bar.
 */
export function dayKeysInWindow(from: Date, to: Date): string[] {
  const firstDay = Math.floor(from.getTime() / DAY_MS);
  const lastDay = Math.floor(to.getTime() / DAY_MS);
  if (lastDay < firstDay) return [];
  const span = Math.min(lastDay - firstDay, MAX_WINDOW_DAYS);
  return Array.from({ length: span + 1 }, (_, offset) =>
    utcDayKey(new Date((firstDay + offset) * DAY_MS)),
  );
}

/** Maps a `YYYY-MM-DD` UTC day onto its ISO weekday key (Monday `1` … Sunday `7`). */
export function weekdayKeyOf(day: string): string {
  const jsDay = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return String(((jsDay + 6) % 7) + 1);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Projects a metric onto the dense `keys` axis for each of `serverIds` and
 * derives the stacked totals and KPI triple from the same rounded per-server
 * values, so `sum(stacked bars) === kpi.total` holds exactly.
 *
 * @param keys Dense x-axis (days, hour-of-day or weekday buckets).
 * @param serverIds Servers to emit a series for, in display order.
 * @param valueAt Metric lookup; must return 0 for missing combinations.
 */
export function buildSeries(
  keys: string[],
  serverIds: string[],
  valueAt: (serverId: string, key: string) => number,
): StatisticsSeries {
  const byServer = serverIds.map((serverId) => ({
    server_id: serverId,
    points: keys.map((key) => ({ key, value: roundTo(valueAt(serverId, key), 1) })),
  }));

  const totals = keys.map((key, index) => ({
    key,
    value: roundTo(
      byServer.reduce((sum, entry) => sum + (entry.points[index]?.value ?? 0), 0),
      1,
    ),
  }));

  const total = roundTo(
    totals.reduce((sum, point) => sum + point.value, 0),
    1,
  );
  const max = totals.reduce((best, point) => Math.max(best, point.value), 0);
  const avg = keys.length > 0 ? roundTo(total / keys.length, 1) : 0;

  return { by_server: byServer, totals, kpi: { avg, max, total } };
}

/**
 * Renders the whole payload as RFC-4180 long-format CSV
 * (`section,metric,server_id,key,value`), the shape spreadsheets open without
 * any reshaping.
 */
export function toStatisticsCsv(payload: StatisticsPayload): string {
  const lines: string[] = ['section,metric,server_id,key,value'];
  const push = (section: string, metric: string, serverId: string, key: string, value: string) => {
    lines.push(
      [
        escapeCsvField(section),
        escapeCsvField(metric),
        escapeCsvField(serverId),
        escapeCsvField(key),
        escapeCsvField(value),
      ].join(','),
    );
  };

  push('meta', 'from', '', '', payload.from);
  push('meta', 'to', '', '', payload.to);
  for (const server of payload.servers) {
    push('meta', 'server_name', server.server_id, '', server.display_name);
  }

  const sections: Array<[string, Array<[string, StatisticsSeries]>]> = [
    [
      'population',
      [
        ['avg_online', payload.population.avg_online],
        ['peak_online', payload.population.peak_online],
        ['avg_queue', payload.population.avg_queue],
        ['by_hour', payload.population.by_hour],
        ['by_weekday', payload.population.by_weekday],
      ],
    ],
    ['matches', [['by_day', payload.matches.by_day]]],
    [
      'community',
      [
        ['new_players', payload.community.new_players],
        ['chat_messages', payload.community.chat_messages],
        ['teamkills', payload.community.teamkills],
      ],
    ],
    [
      'moderation',
      [
        ['punishments', payload.moderation.punishments],
        ['avg_admins', payload.moderation.avg_admins],
        ['peak_admins', payload.moderation.peak_admins],
      ],
    ],
  ];

  for (const [section, series] of sections) {
    for (const [metric, value] of series) {
      for (const entry of value.by_server) {
        for (const point of entry.points) {
          push(section, metric, entry.server_id, point.key, String(point.value));
        }
      }
    }
  }

  for (const entry of payload.matches.modes)
    push('matches', 'mode', '', entry.mode, String(entry.matches));
  for (const entry of payload.matches.maps)
    push('matches', 'map', '', entry.map, String(entry.matches));

  for (const [, series] of sections) {
    for (const [metric, value] of series) {
      push('kpi', metric, '', 'avg', String(value.kpi.avg));
      push('kpi', metric, '', 'max', String(value.kpi.max));
      push('kpi', metric, '', 'total', String(value.kpi.total));
    }
  }

  return `${lines.join('\r\n')}\r\n`;
}

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

// A type alias, not an interface: `db.execute<T>` constrains T to
// `Record<string, unknown>`, which interfaces do not satisfy implicitly.
type DailyRow = {
  server_id: string;
  day: string;
  avg_online: number;
  peak_online: number;
  avg_queue: number;
  matches: number;
  modes: Record<string, number> | null;
  maps: Record<string, number> | null;
  new_players: number;
  chat_messages: number;
  teamkills: number;
  punishments: number;
  avg_admins: number;
  peak_admins: number;
};

/** `${serverId}|${key}` → value, the lookup shape {@link buildSeries} consumes. */
type Grid = Map<string, number>;

function gridKey(serverId: string, key: string): string {
  return `${serverId}|${key}`;
}

function readGrid(grid: Grid): (serverId: string, key: string) => number {
  return (serverId, key) => grid.get(gridKey(serverId, key)) ?? 0;
}

function sortedBreakdown(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const statisticsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/statistics',
    { config: { audit: false }, schema: { querystring: statisticsQuery } },
    async (req, reply) => {
      const guard = panelGuard(req, reply);
      if (guard) return guard;

      const { from, to } = resolveWindow(req.query.from, req.query.to);
      const days = dayKeysInWindow(from, to);
      const requested = parseServerFilter(req.query.servers);
      const fromDay = days[0] ?? utcDayKey(from);
      const toDay = days[days.length - 1] ?? fromDay;

      const payload = await computeStatistics(app, { fromDay, toDay, days, requested });
      const body: StatisticsPayload = {
        from: from.toISOString(),
        to: to.toISOString(),
        ...payload,
      };

      if (req.query.format === 'csv') {
        void reply.header('content-type', 'text/csv; charset=utf-8');
        void reply.header('content-disposition', 'attachment; filename="statistics.csv"');
        return toStatisticsCsv(body);
      }

      return body;
    },
  );
};

async function computeStatistics(
  app: FastifyInstance,
  params: { fromDay: string; toDay: string; days: string[]; requested: string[] },
): Promise<Omit<StatisticsPayload, 'from' | 'to'>> {
  const { fromDay, toDay, days, requested } = params;
  // Server id lists travel as a comma-joined string: drizzle's `sql` template
  // flattens a JS array into adjacent chunks rather than binding one array
  // parameter, which produces invalid SQL.
  const filter = requested.length > 0 ? requested.join(',') : null;

  const serverRows = (await app.db.execute<{ id: string; display_name: string }>(sql`
    SELECT s.id, s.display_name
    FROM servers s
    WHERE s.deleted_at IS NULL
      AND (${filter}::text IS NULL OR s.id = ANY(string_to_array(${filter}::text, ',')::uuid[]))
    ORDER BY s.display_name ASC, s.id ASC
  `)) as unknown as Array<{ id: string; display_name: string }>;

  const serverIds = serverRows.map((row) => row.id);
  const serverIdCsv = serverIds.join(',');
  const servers = serverRows.map((row) => ({
    server_id: row.id,
    display_name: row.display_name,
  }));

  const dailyRows =
    serverIds.length === 0
      ? []
      : ((await app.db.execute<DailyRow>(sql`
          SELECT server_id, day::text AS day, avg_online, peak_online, avg_queue, matches,
                 modes, maps, new_players, chat_messages, teamkills, punishments,
                 avg_admins, peak_admins
          FROM server_daily_stats
          WHERE day >= ${fromDay}::date AND day <= ${toDay}::date
            AND server_id = ANY(string_to_array(${serverIdCsv}::text, ',')::uuid[])
        `)) as unknown as DailyRow[]);

  const grids: Record<string, Grid> = {
    avg_online: new Map(),
    peak_online: new Map(),
    avg_queue: new Map(),
    matches: new Map(),
    new_players: new Map(),
    chat_messages: new Map(),
    teamkills: new Map(),
    punishments: new Map(),
    avg_admins: new Map(),
    peak_admins: new Map(),
  };
  const weekdaySums = new Map<string, { sum: number; days: number }>();
  const modeCounts = new Map<string, number>();
  const mapCounts = new Map<string, number>();

  for (const row of dailyRows) {
    const cell = gridKey(row.server_id, row.day);
    grids.avg_online?.set(cell, Number(row.avg_online));
    grids.peak_online?.set(cell, Number(row.peak_online));
    grids.avg_queue?.set(cell, Number(row.avg_queue));
    grids.matches?.set(cell, Number(row.matches));
    grids.new_players?.set(cell, Number(row.new_players));
    grids.chat_messages?.set(cell, Number(row.chat_messages));
    grids.teamkills?.set(cell, Number(row.teamkills));
    grids.punishments?.set(cell, Number(row.punishments));
    grids.avg_admins?.set(cell, Number(row.avg_admins));
    grids.peak_admins?.set(cell, Number(row.peak_admins));

    const weekdayCell = gridKey(row.server_id, weekdayKeyOf(row.day));
    const bucket = weekdaySums.get(weekdayCell) ?? { sum: 0, days: 0 };
    bucket.sum += Number(row.avg_online);
    bucket.days += 1;
    weekdaySums.set(weekdayCell, bucket);

    for (const [mode, count] of Object.entries(row.modes ?? {})) {
      modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + Number(count));
    }
    for (const [map, count] of Object.entries(row.maps ?? {})) {
      mapCounts.set(map, (mapCounts.get(map) ?? 0) + Number(count));
    }
  }

  // Hour-of-day has no daily-row representation, so it is computed live over the
  // window's sessions — a single pass bounded by the window, not AN-1's per-tick
  // correlated subquery.
  const hourRows =
    serverIds.length === 0
      ? []
      : ((await app.db.execute<{ server_id: string; hour: number; seconds: number | string }>(sql`
          SELECT seg.server_id,
                 (seg.hour_number % 24)::int AS hour,
                 SUM(seg.seconds)::bigint AS seconds
          FROM (
            SELECT ps.server_id,
                   gh.hour_number,
                   GREATEST(
                     0,
                     FLOOR(
                       LEAST(
                         EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, now())),
                         (gh.hour_number + 1) * ${HOUR_SECONDS}
                       )
                       - GREATEST(
                         EXTRACT(EPOCH FROM ps.connected_at),
                         gh.hour_number * ${HOUR_SECONDS}
                       )
                     )
                   )::bigint AS seconds
            FROM player_sessions ps
            CROSS JOIN LATERAL generate_series(
              FLOOR(EXTRACT(EPOCH FROM ps.connected_at) / ${HOUR_SECONDS})::bigint,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(ps.disconnected_at, now())) / ${HOUR_SECONDS})::bigint
            ) AS gh(hour_number)
            WHERE ps.mode = 'online'
              AND ps.server_id = ANY(string_to_array(${serverIdCsv}::text, ',')::uuid[])
              AND ps.connected_at < (${toDay}::date + 1)::timestamptz
              AND COALESCE(ps.disconnected_at, now()) > ${fromDay}::date::timestamptz
              AND gh.hour_number BETWEEN
                    FLOOR(EXTRACT(EPOCH FROM ${fromDay}::date::timestamptz) / ${HOUR_SECONDS})::bigint
                AND FLOOR(EXTRACT(EPOCH FROM (${toDay}::date + 1)::timestamptz) / ${HOUR_SECONDS})::bigint - 1
          ) seg
          WHERE seg.seconds > 0
          GROUP BY seg.server_id, hour
        `)) as unknown as Array<{ server_id: string; hour: number; seconds: number | string }>);

  const hourGrid: Grid = new Map();
  const hourDenominator = Math.max(1, days.length) * HOUR_SECONDS;
  for (const row of hourRows) {
    const key = String(Number(row.hour)).padStart(2, '0');
    hourGrid.set(gridKey(row.server_id, key), Number(row.seconds) / hourDenominator);
  }

  const daily = (metric: string) =>
    buildSeries(days, serverIds, readGrid(grids[metric] ?? new Map()));

  return {
    days,
    servers,
    population: {
      avg_online: daily('avg_online'),
      peak_online: daily('peak_online'),
      avg_queue: daily('avg_queue'),
      by_hour: buildSeries(HOUR_KEYS, serverIds, readGrid(hourGrid)),
      by_weekday: buildSeries(WEEKDAY_KEYS, serverIds, (serverId, key) => {
        const bucket = weekdaySums.get(gridKey(serverId, key));
        return bucket && bucket.days > 0 ? bucket.sum / bucket.days : 0;
      }),
    },
    matches: {
      by_day: daily('matches'),
      modes: sortedBreakdown(modeCounts).map(([mode, matches]) => ({ mode, matches })),
      maps: sortedBreakdown(mapCounts).map(([map, matches]) => ({ map, matches })),
    },
    community: {
      new_players: daily('new_players'),
      chat_messages: daily('chat_messages'),
      teamkills: daily('teamkills'),
    },
    moderation: {
      punishments: daily('punishments'),
      avg_admins: daily('avg_admins'),
      peak_admins: daily('peak_admins'),
    },
  };
}

export default statisticsRoutes;
