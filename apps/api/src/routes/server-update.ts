import { servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishDepotProgressDone, publishDepotProgressLine } from '../lib/depot-progress.js';

const idParams = z.object({ id: z.string().uuid() });

const serverUpdateRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/update',
    {
      config: {
        permissions: ['server:update'],
        audit: { action: 'server.game_update', resource: 'server' },
      },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (row.status !== 'stopped' && row.status !== 'ready') {
        reply.code(409);
        return { error: 'server_must_be_stopped' };
      }

      const startedAt = new Date().toISOString();
      const acquired = await app.redis.set('depot:updating', startedAt, 'EX', 3600, 'NX');
      if (!acquired) {
        reply.code(409);
        return { error: 'depot_update_in_progress' };
      }

      (async () => {
        const dedicated = app.makeBridgeClient();
        let finalStatus: 'done' | 'error' = 'done';
        let finalError: string | undefined;
        try {
          await dedicated.connect();
          await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            void publishDepotProgressLine(app.redis, frame.stream, text);
          });
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
          );
        } catch (err) {
          finalStatus = 'error';
          finalError = (err as Error).message;
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({
              finished_at: new Date().toISOString(),
              status: 'failed',
              error: finalError,
            }),
          );
        } finally {
          await publishDepotProgressDone(app.redis, finalStatus, finalError);
          await app.redis.del('depot:updating');
          await dedicated.close().catch(() => undefined);
        }
      })();

      return { status: 'started', server_id: row.id, started_at: startedAt };
    },
  );
};

export default serverUpdateRoutes;
