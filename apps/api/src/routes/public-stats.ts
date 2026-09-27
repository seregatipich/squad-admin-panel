import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  analyticsAggregatesSchema,
  computeAnalyticsAggregates,
  escapeCsvField,
  POPULAR_LIMIT_DEFAULT,
  POPULAR_LIMIT_MAX,
  resolveWindow,
} from './analytics.js';

const publicStatsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(POPULAR_LIMIT_MAX).default(POPULAR_LIMIT_DEFAULT),
});

/**
 * Response shape for the public stats portal: the same curated aggregates as
 * the panel dashboard, minus any server/player-identifying fields.
 */
export const publicStatsResponse = z.object({
  from: z.string(),
  to: z.string(),
  ...analyticsAggregatesSchema.shape,
});

/** Payload served by `GET /api/v1/public/stats`. */
export type PublicStatsPayload = z.infer<typeof publicStatsResponse>;

function toCsv(payload: PublicStatsPayload): string {
  const lines: string[] = ['section,key,value'];
  const push = (section: string, key: string, value: string | number) => {
    lines.push(
      [escapeCsvField(section), escapeCsvField(key), escapeCsvField(String(value))].join(','),
    );
  };
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

/** Seconds a computed public-stats payload is served from Redis. */
export const PUBLIC_STATS_CACHE_TTL_SECONDS = 300;
/** Requests per minute per client IP, on each of the two public-stats routes. */
export const PUBLIC_STATS_RATE_LIMIT = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Builds the payload for a window, through a Redis cache (#30, finding #246):
 * the route is anonymous and every miss costs five aggregate queries, so the
 * window is widened to whole hours (start floored, end ceiled) and the result
 * cached under that key for {@link PUBLIC_STATS_CACHE_TTL_SECONDS}. Without
 * the rounding the default window (`to = now`) would never hit the cache. A
 * Redis failure only costs the cache — the payload is still computed.
 */
async function buildPayload(
  app: FastifyInstance,
  query: z.infer<typeof publicStatsQuery>,
): Promise<PublicStatsPayload> {
  const window = resolveWindow(query.from, query.to);
  const fromIso = new Date(Math.floor(window.from.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  const toIso = new Date(Math.ceil(window.to.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  const cacheKey = `public-stats:v1:${fromIso}:${toIso}:${query.limit}`;

  try {
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as PublicStatsPayload;
  } catch (err) {
    app.log.warn({ err }, 'public-stats: cache read failed');
  }

  const aggregates = await computeAnalyticsAggregates(app, {
    serverId: null,
    fromIso,
    toIso,
    limit: query.limit,
  });
  const payload: PublicStatsPayload = { from: fromIso, to: toIso, ...aggregates };

  try {
    await app.redis.set(cacheKey, JSON.stringify(payload), 'EX', PUBLIC_STATS_CACHE_TTL_SECONDS);
  } catch (err) {
    app.log.warn({ err }, 'public-stats: cache write failed');
  }
  return payload;
}

const publicRouteConfig = {
  audit: false,
  public: true,
  rateLimit: { max: PUBLIC_STATS_RATE_LIMIT, timeWindow: '1 minute' },
} as const;

/**
 * Public, unauthenticated stats portal. Serves a curated, PII-free aggregate
 * over network-wide match/session data (peak concurrent players by hour,
 * match outcomes, and popular maps/layers) — no session, no permissions
 * check, and no player- or server-identifying fields in the response.
 * Responses are cached per hour-aligned window and each route carries its own
 * per-IP rate limit, so anonymous traffic cannot keep Postgres busy.
 */
const publicStatsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/public/stats',
    { config: publicRouteConfig, schema: { querystring: publicStatsQuery } },
    async (req, reply) => {
      const payload = await buildPayload(app, req.query);

      if (req.query.format === 'csv') {
        void reply.header('content-type', 'text/csv; charset=utf-8');
        void reply.header('content-disposition', 'attachment; filename="public-stats.csv"');
        return toCsv(payload);
      }

      return payload;
    },
  );

  fast.get(
    '/api/v1/public/stats.csv',
    { config: publicRouteConfig, schema: { querystring: publicStatsQuery } },
    async (req, reply) => {
      const payload = await buildPayload(app, req.query);
      void reply.header('content-type', 'text/csv; charset=utf-8');
      void reply.header('content-disposition', 'attachment; filename="public-stats.csv"');
      return toCsv(payload);
    },
  );
};

export default publicStatsRoutes;
