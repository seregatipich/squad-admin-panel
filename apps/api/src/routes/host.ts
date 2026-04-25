import {
  HOST_METRICS_STREAM,
  PERMISSION_KEYS,
  SYSTEM_ROLE_CLEARANCE,
  SYSTEM_ROLE_PERMISSIONS,
} from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const hostRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/permissions',
    {
      config: { audit: false },
    },
    async () => ({
      permissions: PERMISSION_KEYS,
      roles: Object.entries(SYSTEM_ROLE_PERMISSIONS).map(([name, keys]) => ({
        name,
        clearance: SYSTEM_ROLE_CLEARANCE[name as keyof typeof SYSTEM_ROLE_CLEARANCE],
        permissions: keys,
      })),
    }),
  );

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
    '/api/v1/host/bridge-status',
    {
      config: { audit: false },
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
      const { seconds } = req.query as { seconds: number };
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
        try {
          v.push(JSON.parse(obj.v) as number[]);
          ts.push(idMs);
        } catch {
          // skip malformed sample
        }
      }
      return { ts, v };
    },
  );
};

export default hostRoutes;
