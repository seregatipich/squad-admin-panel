import { servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';

const idParams = z.object({ id: z.string().uuid() });
const metricsQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const MAX_POINTS = 1000;

const serverMetricsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

  fast.get(
    '/api/v1/servers/:id/metrics',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParams, querystring: metricsQuery },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const since = req.query.since ?? new Date(Date.now() - 3_600_000).toISOString();
      const until = req.query.until ?? new Date().toISOString();

      const sinceMs = new Date(since).getTime();
      const untilMs = new Date(until).getTime();

      // `container:metrics:<id>` is capped by MAXLEN ~2880 (metrics-sampler
      // samples every 5s, so the stream only ever holds ~4h). An XRANGE with
      // COUNT takes the OLDEST entries in [since, until] — for a 6h/24h
      // window (which exceeds retention) that silently truncated the
      // response to the start of the stored window, so the chart's "last
      // point" was stale by however much of the window fell outside
      // retention, not the current reading. XREVRANGE instead takes the
      // NEWEST entries first, which is always the tail of what is actually
      // stored, then this reverses them back into chronological order (#623).
      const streamKey = `container:metrics:${row.id}`;
      const raw = (
        (await app.redis.xrevrange(
          streamKey,
          String(untilMs),
          String(sinceMs),
          'COUNT',
          String(MAX_POINTS * 2),
        )) as Array<[string, string[]]>
      ).reverse();

      function parseEntry(entry: [string, string[]] | undefined): Record<string, unknown> | null {
        if (!entry) return null;
        const [, kv] = entry;
        const vIdx = kv.indexOf('v');
        if (vIdx < 0) return null;
        const value = kv[vIdx + 1];
        if (!value) return null;
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }

      const points: Array<Record<string, unknown>> = [];
      const step = raw.length > MAX_POINTS ? Math.ceil(raw.length / MAX_POINTS) : 1;
      const lastIndex = raw.length - 1;

      for (let i = 0; i < raw.length; i += step) {
        const parsed = parseEntry(raw[i]);
        if (parsed) points.push(parsed);
      }
      // Downsampling by a fixed stride can land short of the final index, so
      // the freshest sample — the point the UI reads as "current" — must be
      // appended explicitly rather than left to chance (#623).
      if (lastIndex >= 0 && lastIndex % step !== 0) {
        const parsed = parseEntry(raw[lastIndex]);
        if (parsed) points.push(parsed);
      }

      return { server_id: row.id, since, until, points };
    },
  );
};

export default serverMetricsRoutes;
