import { servers } from '@squad/db/schema';
import { RNSQUADJS_CUTOVER_SET } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildSidecarEnv, sidecarContainerName, writeSidecarConfig } from '../lib/rnsquadjs.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ mode: z.enum(['production', 'shadow']) });

// One worker-log-ingest reconcile interval (15s) plus a 1s margin. After SADD,
// the worker drops this server's legacy log tailer on its next tick; we wait a
// full tick before launching the production sidecar so the legacy tailer and
// the sidecar never publish to the real stream at the same time (duplicates).
export const CUTOVER_TICK_MS = 16_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const serverRnsquadjsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/rnsquadjs',
    {
      config: {
        permissions: ['server:stop'],
        audit: { action: 'server.rnsquadjs.cutover', resource: 'server' },
      },
      schema: { params: paramsSchema, body: bodySchema },
    },
    async (req, reply) => {
      const s = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!s) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const serverId = s.id;
      const redisUrl = process.env.RNSQUADJS_REDIS_URL;

      if (req.body.mode === 'production') {
        const log = req.log;
        await app.redis.sadd(RNSQUADJS_CUTOVER_SET, serverId);
        // Fire-and-forget: a 16s in-handler wait would risk client/proxy
        // timeouts (mirrors server-install's detached runInstall). The 202 is
        // returned now; the cutover finishes after the reconcile tick below.
        (async () => {
          await sleep(CUTOVER_TICK_MS);
          // The cutover set is the desired-state token: a concurrent shadow
          // rollback SREMs it. Bail early if it was superseded during the wait
          // so we skip the redundant config/rm churn entirely.
          if ((await app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId)) !== 1) return;
          await writeSidecarConfig(app, serverId);
          await app.bridge
            .containerRm({ name: sidecarContainerName(serverId) })
            .catch(() => undefined);
          // Re-confirm membership immediately before launch (no await between
          // this check and the run): never start a production-mode sidecar once
          // a rollback has SREM'd, or the resumed legacy tailer and the sidecar
          // would both publish to the real stream (duplicates).
          if ((await app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId)) !== 1) return;
          await app.bridge.containerRunRnsquadjs({
            server_id: serverId,
            env: { ...buildSidecarEnv(serverId, 'production', redisUrl) },
          });
        })().catch(async (err) => {
          // A supersession abort resolves (early `return`) and never lands here,
          // so this only fires on a genuine failure. log-ingest already dropped
          // this server's legacy tailer on SADD; without the SREM it would be
          // stranded with no publisher. Roll the desired state back to legacy.
          await app.redis.srem(RNSQUADJS_CUTOVER_SET, serverId).catch(() => undefined);
          log.error({ err, id: serverId }, 'rnsquadjs cutover failed; rolled back to legacy');
        });
        reply.code(202);
        return { server_id: serverId, mode: 'production', status: 'switching' };
      }

      // Rollback: stand the shadow sidecar back up BEFORE SREM so the legacy
      // tailer only resumes once a publisher exists. A brief event gap is
      // acceptable; overlapping publishers (duplicates) are not.
      try {
        await writeSidecarConfig(app, serverId);
        await app.bridge
          .containerRm({ name: sidecarContainerName(serverId) })
          .catch(() => undefined);
        const sidecar = await app.bridge.containerRunRnsquadjs({
          server_id: serverId,
          env: { ...buildSidecarEnv(serverId, 'shadow', redisUrl) },
        });
        return { server_id: serverId, mode: 'shadow', container_id: sidecar.container_id };
      } finally {
        // SREM even when the relaunch throws: a dead sidecar with the legacy
        // tailer resumed is the safe degraded state. On a throw the error still
        // propagates after this (5xx), so the caller learns the relaunch failed.
        await app.redis.srem(RNSQUADJS_CUTOVER_SET, serverId);
      }
    },
  );
};

export default serverRnsquadjsRoutes;
