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

      // Read the whole window: the sampler caps the stream with MAXLEN, so it
      // stays bounded, and a COUNT here would keep only the oldest entries.
      const streamKey = `container:metrics:${row.id}`;
      const raw = (await app.redis.xrange(streamKey, String(sinceMs), String(untilMs))) as Array<
        [string, string[]]
      >;

      const step = raw.length > MAX_POINTS ? Math.ceil(raw.length / MAX_POINTS) : 1;
      const sampled = raw.filter((_, i) => i % step === 0);
      // Always keep the newest entry so the chart ends at the current state.
      const newest = raw.at(-1);
      if (newest && sampled.at(-1) !== newest) {
        if (sampled.length >= MAX_POINTS) sampled.pop();
        sampled.push(newest);
      }

      const points: Array<Record<string, unknown>> = [];
      for (const [, kv] of sampled) {
        const vIdx = kv.indexOf('v');
        if (vIdx < 0) continue;
        const value = kv[vIdx + 1];
        if (!value) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
        points.push(parsed);
      }

      return { server_id: row.id, since, until, points };
    },
  );
};

export default serverMetricsRoutes;
