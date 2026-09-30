import { HOST_METRICS_STREAM } from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Query-string boolean: only `true`/`1` and `false`/`0` are accepted.
 * `z.coerce.boolean()` would turn the string `'false'` into `true`.
 */
const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const hostMetricsSample = z.array(z.number());

const hostRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/v1/host/info',
    {
      config: { permissions: ['host:view'], audit: false },
    },
    async () => app.bridge.hostInfo(),
  );

  app.get(
    '/api/v1/host/metrics',
    {
      config: { permissions: ['host:metrics'], audit: false },
    },
    async () => app.bridge.hostMetrics(),
  );

  app.get(
    '/api/v1/host/disk-usage',
    {
      config: { permissions: ['host:view'], audit: false },
      schema: {
        querystring: z.object({
          refresh: queryBoolean.optional(),
        }),
      },
    },
    async (req) => {
      const { refresh } = req.query;
      const usage = await app.bridge.panelDiskUsage(refresh ? { force: true } : undefined);
      const hasCapacity = usage.host_total_bytes > 0;
      const panelPct = hasCapacity ? (usage.total_panel_bytes / usage.host_total_bytes) * 100 : 0;
      const usedPct = hasCapacity ? (usage.host_used_bytes / usage.host_total_bytes) * 100 : 0;
      return { ...usage, panel_pct: panelPct, other_pct: Math.max(0, usedPct - panelPct) };
    },
  );

  app.get(
    '/api/v1/host/bridge-status',
    {
      config: { permissions: ['host:view'], audit: false },
    },
    async () => {
      try {
        const start = Date.now();
        const res = await app.bridge.ping();
        return {
          connected: true,
          version: res.version,
          hostname: res.hostname,
          round_trip_ms: Date.now() - start,
        };
      } catch (err) {
        return {
          connected: false,
          error: (err as Error).message,
        };
      }
    },
  );
  app.get(
    '/api/v1/host/metrics/history',
    {
      config: { permissions: ['host:metrics'], audit: false },
      schema: {
        querystring: z.object({
          seconds: z.coerce.number().int().min(1).max(86_400).default(86_400),
        }),
      },
    },
    async (req) => {
      const { seconds } = req.query;
      const minId = `${Date.now() - seconds * 1000}-0`;
      const items = (await app.redis.xrange(HOST_METRICS_STREAM, minId, '+')) as Array<
        [string, string[]]
      >;
      const ts: number[] = [];
      const v: number[][] = [];
      for (const [id, fields] of items) {
        const idMs = Number.parseInt(id.split('-')[0] ?? '0', 10);
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i] ?? ''] = fields[i + 1] ?? '';
        if (!obj.v) continue;
        let decoded: unknown;
        try {
          decoded = JSON.parse(obj.v);
        } catch {
          continue;
        }
        const sample = hostMetricsSample.safeParse(decoded);
        if (!sample.success) continue;
        v.push(sample.data);
        ts.push(idMs);
      }
      return { ts, v };
    },
  );
};

export default hostRoutes;
