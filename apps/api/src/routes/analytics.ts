import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 92;
const POPULAR_LIMIT_DEFAULT = 10;
const POPULAR_LIMIT_MAX = 50;
const DAY_MS = 86_400_000;

const dashboardQuery = z.object({
  server_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(POPULAR_LIMIT_MAX).default(POPULAR_LIMIT_DEFAULT),
});

const peakEntrySchema = z.object({ hour: z.number().int(), peak_players: z.number().int() });
const popularMapSchema = z.object({ map: z.string(), matches: z.number().int() });
const popularLayerSchema = z.object({ layer: z.string(), matches: z.number().int() });

const dashboardResponse = z.object({
  server_id: z.string().uuid().nullable(),
  from: z.string(),
  to: z.string(),
  summary: z.object({
    total_matches: z.number().int(),
    total_online_hours: z.number(),
    unique_players: z.number().int(),
    avg_match_duration_seconds: z.number().nullable(),
  }),
  peak_by_hour: z.array(peakEntrySchema),
  match_outcomes: z.object({
    team1: z.number().int(),
    team2: z.number().int(),
    draw: z.number().int(),
    unknown: z.number().int(),
    total: z.number().int(),
  }),
  popular_maps: z.array(popularMapSchema),
  popular_layers: z.array(popularLayerSchema),
});

type DashboardPayload = z.infer<typeof dashboardResponse>;

interface ResolvedWindow {
  from: Date;
  to: Date;
}

function resolveWindow(fromRaw?: string, toRaw?: string): ResolvedWindow {
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  const span = to.getTime() - from.getTime();
  if (span < 0) return { from: to, to };
  if (span > MAX_WINDOW_DAYS * DAY_MS) {
    return { from: new Date(to.getTime() - MAX_WINDOW_DAYS * DAY_MS), to };
  }
  return { from, to };
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

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(payload: DashboardPayload): string {
  const lines: string[] = ['section,key,value'];
  const push = (section: string, key: string, value: string | number) => {
    lines.push(
      [escapeCsvField(section), escapeCsvField(key), escapeCsvField(String(value))].join(','),
    );
  };
  push('meta', 'server_id', payload.server_id ?? 'all');
  push('meta', 'from', payload.from);
  push('meta', 'to', payload.to);
  push('summary', 'total_matches', payload.summary.total_matches);
  push('summary', 'total_online_hours', payload.summary.total_online_hours);
  push('summary', 'unique_players', payload.summary.unique_players);
  push('summary', 'avg_match_duration_seconds', payload.summary.avg_match_duration_seconds ?? '');
  for (const entry of payload.peak_by_hour) {
    push('peak_by_hour', String(entry.hour), entry.peak_players);
  }
  push('match_outcome', 'team1', payload.match_outcomes.team1);
  push('match_outcome', 'team2', payload.match_outcomes.team2);
  push('match_outcome', 'draw', payload.match_outcomes.draw);
  push('match_outcome', 'unknown', payload.match_outcomes.unknown);
  push('match_outcome', 'total', payload.match_outcomes.total);
  for (const entry of payload.popular_maps) push('popular_map', entry.map, entry.matches);
  for (const entry of payload.popular_layers) push('popular_layer', entry.layer, entry.matches);
  return `${lines.join('\r\n')}\r\n`;
}

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/analytics/dashboard',
    { config: { audit: false }, schema: { querystring: dashboardQuery } },
    async (req, reply) => {
      const guard = panelGuard(req, reply);
      if (guard) return guard;

      const serverId = req.query.server_id ?? null;
      const { from, to } = resolveWindow(req.query.from, req.query.to);
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const limit = req.query.limit;

      const matchFilter = sql`m.started_at >= ${fromIso}::timestamptz
        AND m.started_at < ${toIso}::timestamptz
        AND (${serverId}::uuid IS NULL OR m.server_id = ${serverId}::uuid)`;

      const summaryRows = await app.db.execute<{
        total_matches: number;
        avg_duration: number | null;
      }>(sql`
        SELECT count(*)::int AS total_matches,
               avg(m.duration_seconds)::float8 AS avg_duration
        FROM matches m
        WHERE ${matchFilter}
      `);
      const summaryRow = (
        summaryRows as unknown as Array<{ total_matches: number; avg_duration: number | null }>
      )[0];

      const presenceRows = await app.db.execute<{
        online_seconds: number;
        unique_players: number;
      }>(sql`
        SELECT COALESCE(sum(p.online_seconds), 0)::bigint AS online_seconds,
               count(DISTINCT p.player_id)::int AS unique_players
        FROM player_daily_presence p
        WHERE p.day >= ${fromIso}::date
          AND p.day <= ${toIso}::date
          AND (${serverId}::uuid IS NULL OR p.server_id = ${serverId}::uuid)
      `);
      const presenceRow = (
        presenceRows as unknown as Array<{
          online_seconds: number | string;
          unique_players: number;
        }>
      )[0];

      const outcomeRows = await app.db.execute<{ winner: string | null; count: number }>(sql`
        SELECT m.winner AS winner, count(*)::int AS count
        FROM matches m
        WHERE ${matchFilter}
        GROUP BY m.winner
      `);
      const outcomes = { team1: 0, team2: 0, draw: 0, unknown: 0, total: 0 };
      for (const row of outcomeRows as unknown as Array<{ winner: string | null; count: number }>) {
        const count = Number(row.count);
        outcomes.total += count;
        if (row.winner === 'team1') outcomes.team1 += count;
        else if (row.winner === 'team2') outcomes.team2 += count;
        else if (row.winner === 'draw') outcomes.draw += count;
        else outcomes.unknown += count;
      }

      const mapRows = await app.db.execute<{ map: string; matches: number }>(sql`
        SELECT m.map AS map, count(*)::int AS matches
        FROM matches m
        WHERE ${matchFilter} AND m.map IS NOT NULL
        GROUP BY m.map
        ORDER BY matches DESC, m.map ASC
        LIMIT ${limit}
      `);

      const layerRows = await app.db.execute<{ layer: string; matches: number }>(sql`
        SELECT m.layer AS layer, count(*)::int AS matches
        FROM matches m
        WHERE ${matchFilter} AND m.layer IS NOT NULL
        GROUP BY m.layer
        ORDER BY matches DESC, m.layer ASC
        LIMIT ${limit}
      `);

      const peakRows = await app.db.execute<{ hour: number; peak: number }>(sql`
        WITH ticks AS (
          SELECT gs AS wall
          FROM generate_series(
            date_trunc('hour', ${fromIso}::timestamptz AT TIME ZONE 'UTC'),
            ${toIso}::timestamptz AT TIME ZONE 'UTC',
            interval '1 hour'
          ) AS gs
        ),
        samples AS (
          SELECT extract(hour FROM t.wall)::int AS hour,
                 (
                   SELECT count(*)::int
                   FROM player_sessions s
                   WHERE s.connected_at <= (t.wall AT TIME ZONE 'UTC')
                     AND (s.disconnected_at IS NULL OR s.disconnected_at > (t.wall AT TIME ZONE 'UTC'))
                     AND (${serverId}::uuid IS NULL OR s.server_id = ${serverId}::uuid)
                 ) AS concurrent
          FROM ticks t
        )
        SELECT hour, max(concurrent)::int AS peak
        FROM samples
        GROUP BY hour
      `);
      const peakByHourMap = new Map<number, number>();
      for (const row of peakRows as unknown as Array<{ hour: number; peak: number }>) {
        peakByHourMap.set(Number(row.hour), Number(row.peak));
      }
      const peakByHour = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        peak_players: peakByHourMap.get(hour) ?? 0,
      }));

      const onlineSeconds = Number(presenceRow?.online_seconds ?? 0);
      const payload: DashboardPayload = {
        server_id: serverId,
        from: fromIso,
        to: toIso,
        summary: {
          total_matches: Number(summaryRow?.total_matches ?? 0),
          total_online_hours: Math.round((onlineSeconds / 3600) * 100) / 100,
          unique_players: Number(presenceRow?.unique_players ?? 0),
          avg_match_duration_seconds:
            summaryRow?.avg_duration == null ? null : Math.round(Number(summaryRow.avg_duration)),
        },
        peak_by_hour: peakByHour,
        match_outcomes: outcomes,
        popular_maps: (mapRows as unknown as Array<{ map: string; matches: number }>).map(
          (row) => ({ map: row.map, matches: Number(row.matches) }),
        ),
        popular_layers: (layerRows as unknown as Array<{ layer: string; matches: number }>).map(
          (row) => ({ layer: row.layer, matches: Number(row.matches) }),
        ),
      };

      if (req.query.format === 'csv') {
        void reply.header('content-type', 'text/csv; charset=utf-8');
        void reply.header('content-disposition', 'attachment; filename="analytics-dashboard.csv"');
        return toCsv(payload);
      }

      return payload;
    },
  );
};

export default analyticsRoutes;
