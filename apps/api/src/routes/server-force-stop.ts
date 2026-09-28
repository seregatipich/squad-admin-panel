import { servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';
import { stopSidecar } from '../lib/sidecar-lifecycle.js';

const serverIdParams = z.object({ id: z.string().uuid() });

const STOPPABLE_STATUSES = new Set(['running', 'starting', 'stopping']);

const forceStopRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

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

      // Same planned-stop fence as POST /stop (#285): the status reconciler
      // reads it to tell this exit apart from a crash.
      await app.redis.set(`stop:requested:${s.id}`, '1', 'EX', 300);

      await app.bridge.containerRm({ name: `squad-${s.id}`, force: true });

      // The sidecar would otherwise keep reconnecting to the dead server's
      // RCON. Best-effort: it is not load-bearing for the stop.
      await stopSidecar(app.bridge, s.id, (err) => {
        req.log.warn({ err: (err as Error).message, id: s.id }, 'sidecar stop failed (continuing)');
      });

      // Compare-and-set on the status read above: a concurrent start that
      // finished while the container was being removed wrote its own status,
      // and a stale force-stop must not overwrite it with 'stopped'.
      const updated = await app.db
        .update(servers)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(and(eq(servers.id, s.id), eq(servers.status, s.status)))
        .returning({ id: servers.id });
      if (updated.length === 0) {
        reply.code(409);
        return { error: 'server_status_changed' };
      }

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
