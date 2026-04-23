import type { FastifyPluginAsync } from 'fastify';

const hostRoutes: FastifyPluginAsync = async (app) => {
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
};

export default hostRoutes;
