import type { FastifyPluginAsync } from 'fastify';

const hostActionsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/v1/host/restart',
    {
      config: {
        permissions: ['host:metrics'],
        audit: { action: 'host.bridge.restart', resource: 'host' },
      },
    },
    async (_req, reply) => {
      try {
        const res = await app.bridge.hostAgentRestart();
        return { status: res.status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/closed|reset|EPIPE/i.test(message)) {
          return { status: 'restarting' };
        }
        reply.code(502);
        return { error: 'bridge_unreachable', detail: message };
      }
    },
  );
};

export default hostActionsRoutes;
