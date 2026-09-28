import { servers } from '@squad/db/schema';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { acquireDepotLock, releaseDepotLock } from '../lib/depot-lock.js';
import { publishDepotProgressDone, publishDepotProgressLine } from '../lib/depot-progress.js';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';

const idParams = z.object({ id: z.string().uuid() });

/**
 * Statuses in which a container server has (or is about to have) the shared
 * depot volume mounted by a live process. `installing` counts because an
 * install ends with a containerRun that mounts the depot.
 */
const LIVE_STATUSES = ['installing', 'starting', 'running', 'stopping'];

const serverUpdateRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

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
      if (!(await acquireDepotLock(app.redis, startedAt))) {
        reply.code(409);
        return { error: 'depot_update_in_progress' };
      }

      // The depot is one volume mounted into every Squad container, so this
      // "per-server" update rewrites the install under every server on the
      // host (#20). Refuse while any other container server is live. The check
      // runs after the lock is taken because /start, /restart and /install
      // refuse while it is held, so a server stopped now stays down until the
      // update ends.
      const liveServers = await app.db
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            ne(servers.id, row.id),
            eq(servers.runtime, 'container'),
            isNull(servers.deletedAt),
            inArray(servers.status, LIVE_STATUSES),
          ),
        );
      if (liveServers.length > 0) {
        await releaseDepotLock(app.redis, startedAt);
        reply.code(409);
        return { error: 'servers_running', server_ids: liveServers.map((s) => s.id) };
      }

      (async () => {
        const dedicated = app.makeBridgeClient();
        let finalStatus: 'done' | 'error' = 'done';
        let finalError: string | undefined;
        try {
          await dedicated.connect();
          // Each progress line is awaited (not fired-and-forgotten): a silently
          // dropped xadd would leave depot:last_update=ok even though a
          // progress frame never made it to the stream.
          const streamWrites: Promise<void>[] = [];
          const streamWriteErrors: unknown[] = [];
          const { exit_code: exitCode } = await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            streamWrites.push(
              publishDepotProgressLine(app.redis, frame.stream, text).catch((error: unknown) => {
                streamWriteErrors.push(error);
              }),
            );
          });
          await Promise.all(streamWrites);
          if (streamWriteErrors.length > 0) throw streamWriteErrors[0];
          // The bridge reports a failed SteamCMD run as a normal reply.
          if (exitCode !== 0) throw new Error(`steamcmd failed with exit code ${exitCode}`);

          await app.redis.set(
            'depot:last_update',
            JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
          );
        } catch (err) {
          finalStatus = 'error';
          finalError = err instanceof Error ? err.message : String(err);
          await app.redis
            .set(
              'depot:last_update',
              JSON.stringify({
                finished_at: new Date().toISOString(),
                status: 'failed',
                error: finalError,
              }),
            )
            .catch((statusError: unknown) => {
              app.log.error(
                { err: statusError, server_id: row.id, update_error: finalError },
                'failed to record depot update failure',
              );
            });
        } finally {
          await publishDepotProgressDone(app.redis, finalStatus, finalError).catch(
            (error: unknown) => {
              app.log.error(
                { err: error, server_id: row.id },
                'failed to publish depot update completion event',
              );
            },
          );
          await releaseDepotLock(app.redis, startedAt).catch((error: unknown) => {
            app.log.error({ err: error, server_id: row.id }, 'failed to release depot update lock');
          });
          await dedicated.close().catch((error: unknown) => {
            app.log.error({ err: error, server_id: row.id }, 'failed to close depot bridge client');
          });
        }
      })().catch((error: unknown) => {
        app.log.error(
          { err: error, server_id: row.id },
          'unexpected depot update background error',
        );
      });

      return { status: 'started', server_id: row.id, started_at: startedAt };
    },
  );
};

export default serverUpdateRoutes;
