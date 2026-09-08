import { servers } from '@squad/db/schema';
import { RNSQUADJS_CUTOVER_SET } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildSidecarEnv, writeSidecarConfig } from '../lib/rnsquadjs.js';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';
import { resolveSidecarRedisUrl } from '../lib/sidecar-config.js';
import { removeAllSidecars } from '../lib/sidecar-lifecycle.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ mode: z.enum(['production', 'shadow']) });

// One worker-log-ingest reconcile interval (15s) plus a 1s margin. After SADD,
// the worker drops this server's legacy log tailer on its next tick; we wait a
// full tick before launching the production sidecar so the legacy tailer and
// the sidecar never publish to the real stream at the same time (duplicates).
export const CUTOVER_TICK_MS = 16_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Effective event source for a server, as reported by the status route. */
export type SidecarMode = 'production' | 'shadow' | 'legacy';

/**
 * Redis key the sidecar's own `RedisPublisher` writes its RCON heartbeat to
 * (`docker/rnsquadjs/plugins/panelBridge/src/redisPublisher.ts`). Shadow-mode
 * sidecars publish under a `:shadow` suffix so they never clobber a
 * production-mode sidecar's key; both must be read to tell a healthy shadow
 * sidecar apart from no sidecar at all.
 *
 * @param serverId - Server the sidecar belongs to.
 * @param mode - Sidecar launch mode whose key is wanted.
 * @returns The full Redis key (written with `SET ... EX 300`).
 */
export function sidecarStatusKey(serverId: string, mode: 'production' | 'shadow'): string {
  return `rnsquadjs:status:${serverId}${mode === 'shadow' ? ':shadow' : ''}`;
}

/** Heartbeat payload as the sidecar serialises it (camelCase, JSON). */
const heartbeatSchema = z.object({
  state: z.enum(['connected', 'disconnected']),
  lastChange: z.string(),
});

export interface SidecarStatus {
  state: 'connected' | 'disconnected';
  last_change: string;
}

/**
 * Decodes a stored heartbeat into the route's snake_case shape.
 *
 * Returns null for an absent key (the 300s TTL lapsed — a first-class
 * "no heartbeat" state, not an error) and also for a malformed payload, so a
 * sidecar writing an unexpected shape degrades to "no signal" rather than 500.
 */
function parseHeartbeat(raw: string | null | undefined): SidecarStatus | null {
  if (raw == null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = heartbeatSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return { state: parsed.data.state, last_change: parsed.data.lastChange };
}

const serverRnsquadjsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

  // Shares its URL with the cutover POST below; Fastify routes on method+URL,
  // so the two never collide.
  fast.get(
    '/api/v1/servers/:id/rnsquadjs',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: paramsSchema },
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
      const [cutoverFlag, heartbeats] = await Promise.all([
        app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId),
        app.redis.mget(
          sidecarStatusKey(serverId, 'production'),
          sidecarStatusKey(serverId, 'shadow'),
        ),
      ]);
      const cutover = cutoverFlag === 1;

      // The cutover set is the desired state, so it decides the mode outright:
      // a member is production even while its heartbeat is missing (sidecar
      // restarting) and even if a stale `:shadow` key still lingers. A
      // non-member with a live shadow heartbeat is soaking in shadow mode;
      // a non-member with neither key is still served by the legacy parser.
      const mode: SidecarMode = cutover
        ? 'production'
        : heartbeats[1] != null
          ? 'shadow'
          : 'legacy';
      const raw = mode === 'production' ? heartbeats[0] : mode === 'shadow' ? heartbeats[1] : null;

      return { server_id: serverId, mode, cutover, status: parseHeartbeat(raw) };
    },
  );

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
      const redisUrl = resolveSidecarRedisUrl();

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
          // Both engines, not just this one: a server already switched to
          // SquadJS2 would otherwise end up with two writers on one stream.
          await removeAllSidecars(app.bridge, serverId);
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
        await removeAllSidecars(app.bridge, serverId);
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
