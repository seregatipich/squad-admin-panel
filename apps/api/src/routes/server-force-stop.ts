import { servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const serverIdParams = z.object({ id: z.string().uuid() });

const STOPPABLE_STATUSES = new Set(['running', 'starting', 'stopping']);

const forceStopRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/force-stop',
    {
      config: {
        permissions: ['server:force_stop'],
        audit: { action: 'server.force_stop', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const s = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!s) {
        reply.code(404);
        return { error: 'not_found' };
      }

      if (!STOPPABLE_STATUSES.has(s.status)) {
        reply.code(409);
        return { error: 'server_not_stoppable', status: s.status };
      }

      await app.bridge.containerRm({ name: `squad-${s.id}`, force: true });

      await app.db
        .update(servers)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(servers.id, s.id));

      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: s.id, status: 'stopped', source: 'force_stop' },
      });

      return { status: 'stopped', server_id: s.id };
    },
  );
};

export default forceStopRoutes;
