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

async function buildPayload(
  app: FastifyInstance,
  query: z.infer<typeof publicStatsQuery>,
): Promise<PublicStatsPayload> {
  const { from, to } = resolveWindow(query.from, query.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const aggregates = await computeAnalyticsAggregates(app, {
    serverId: null,
    fromIso,
    toIso,
    limit: query.limit,
  });

  return { from: fromIso, to: toIso, ...aggregates };
}

/**
 * Public, unauthenticated stats portal. Serves a curated, PII-free aggregate
 * over network-wide match/session data (peak concurrent players by hour,
 * match outcomes, and popular maps/layers) — no session, no permissions
 * check, and no player- or server-identifying fields in the response.
 */
const publicStatsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/public/stats',
    { config: { audit: false }, schema: { querystring: publicStatsQuery } },
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
    { config: { audit: false }, schema: { querystring: publicStatsQuery } },
    async (req, reply) => {
      const payload = await buildPayload(app, req.query);
      void reply.header('content-type', 'text/csv; charset=utf-8');
      void reply.header('content-disposition', 'attachment; filename="public-stats.csv"');
      return toCsv(payload);
    },
  );
};

export default publicStatsRoutes;
