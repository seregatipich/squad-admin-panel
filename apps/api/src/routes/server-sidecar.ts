import { servers } from '@squad/db/schema';
import {
  legacySidecarStatusKey,
  RNSQUADJS_CUTOVER_SET,
  type SidecarEngine,
  SQUADJS2_ENGINE_SET,
  sidecarConfigDir,
  sidecarContainerName,
  sidecarStatusKey,
} from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildSidecarEnv, writeSidecarConfig } from '../lib/rnsquadjs.js';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';
import { resolveSidecarRedisUrl } from '../lib/sidecar-config.js';
import { buildSquadjs2Env, writeSquadjs2Config } from '../lib/squadjs2.js';
import { CUTOVER_TICK_MS } from './server-rnsquadjs.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({
  engine: z.enum(['squadjs2', 'rnsquadjs']),
  mode: z.enum(['production', 'shadow']),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Effective event source for a server, as reported by the status route. */
export type SidecarReportedMode = 'production' | 'shadow' | 'legacy';

const heartbeatSchema = z.object({
  state: z.enum(['connected', 'disconnected']),
  lastChange: z.string(),
});

export interface SidecarStatus {
  state: 'connected' | 'disconnected';
  last_change: string;
}

/**
 * Decodes a stored sidecar status into the route's snake_case shape.
 *
 * Returns null for an absent key (the 300s TTL lapsed — a first-class "no
 * heartbeat" state, not an error) and also for a malformed payload, so a
 * sidecar writing an unexpected shape degrades to "no signal" rather than 500.
 */
export function parseSidecarStatus(raw: string | null | undefined): SidecarStatus | null {
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

const serverSidecarRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

  /**
   * Stops and removes both engines' sidecars for a server.
   *
   * Called before every launch so the `:shadow` stream can never end up with
   * two writers: the engine being switched away from must be gone before its
   * replacement starts, and a same-engine relaunch still needs the old
   * container removed before the name is reused.
   */
  const removeBothSidecars = async (serverId: string): Promise<void> => {
    await Promise.all(
      (['squadjs2', 'rnsquadjs'] as SidecarEngine[]).map((engine) =>
        app.bridge
          .containerRm({ name: sidecarContainerName(engine, serverId), force: true })
          .catch(() => undefined),
      ),
    );
  };

  /**
   * Removes the config directory of the engine a server is moving away from.
   *
   * Only ever called once that engine's container is gone: its config.json is
   * bound read-only, and docker recreates a *directory* at a missing bind source
   * when `--restart unless-stopped` brings the container back — which would then
   * make a later rollback's atomic rename fail with EISDIR.
   */
  const purgeOtherEngineDir = async (engine: SidecarEngine, serverId: string): Promise<void> => {
    const other: SidecarEngine = engine === 'squadjs2' ? 'rnsquadjs' : 'squadjs2';
    await app.bridge
      .directoryDelete({ path: sidecarConfigDir(other, serverId) })
      .catch(() => undefined);
  };

  const launch = async (
    engine: SidecarEngine,
    serverId: string,
    mode: 'production' | 'shadow',
  ): Promise<string> => {
    if (engine === 'squadjs2') {
      await writeSquadjs2Config(app, serverId, mode);
      await removeBothSidecars(serverId);
      await purgeOtherEngineDir(engine, serverId);
      const run = await app.bridge.containerRunSquadjs2({
        server_id: serverId,
        env: { ...buildSquadjs2Env(serverId) },
      });
      return run.container_id;
    }
    await writeSidecarConfig(app, serverId);
    await removeBothSidecars(serverId);
    await purgeOtherEngineDir(engine, serverId);
    const run = await app.bridge.containerRunRnsquadjs({
      server_id: serverId,
      env: { ...buildSidecarEnv(serverId, mode, resolveSidecarRedisUrl()) },
    });
    return run.container_id;
  };

  fast.get(
    '/api/v1/servers/:id/sidecar',
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
      const [cutoverFlag, engineFlag, statuses] = await Promise.all([
        app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId),
        app.redis.sismember(SQUADJS2_ENGINE_SET, serverId),
        // Dual read: a server whose sidecar has not been replaced yet still
        // publishes under the RNSquadJS key names. The fallback goes away with
        // the rest of the RNSquadJS path.
        app.redis.mget(
          sidecarStatusKey(serverId, 'production'),
          sidecarStatusKey(serverId, 'shadow'),
          legacySidecarStatusKey(serverId, 'production'),
          legacySidecarStatusKey(serverId, 'shadow'),
        ),
      ]);
      const cutover = cutoverFlag === 1;
      const engine: SidecarEngine = engineFlag === 1 ? 'squadjs2' : 'rnsquadjs';
      const production = statuses[0] ?? statuses[2];
      const shadow = statuses[1] ?? statuses[3];

      // The cutover set is the desired state, so it decides the mode outright:
      // a member is production even while its status key is missing (sidecar
      // restarting) and even if a stale `:shadow` key still lingers. A
      // non-member with a live shadow key is soaking in shadow mode; a
      // non-member with neither key is still served by the legacy parser.
      const mode: SidecarReportedMode = cutover
        ? 'production'
        : shadow != null
          ? 'shadow'
          : 'legacy';
      const raw = mode === 'production' ? production : mode === 'shadow' ? shadow : null;

      return { server_id: serverId, engine, mode, cutover, status: parseSidecarStatus(raw) };
    },
  );

  fast.post(
    '/api/v1/servers/:id/sidecar',
    {
      config: {
        permissions: ['server:stop'],
        audit: { action: 'server.sidecar.switch', resource: 'server' },
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
      const { engine, mode } = req.body;

      // Engine selection is desired state, recorded before anything is launched
      // so a crash mid-switch leaves the panel's own lifecycle (install, start,
      // restart) launching the engine the operator asked for.
      if (engine === 'squadjs2') {
        await app.redis.sadd(SQUADJS2_ENGINE_SET, serverId);
      } else {
        await app.redis.srem(SQUADJS2_ENGINE_SET, serverId);
      }
      if (mode === 'production') {
        const log = req.log;
        await app.redis.sadd(RNSQUADJS_CUTOVER_SET, serverId);
        // Fire-and-forget: a 16s in-handler wait would risk client/proxy
        // timeouts (mirrors server-install's detached runInstall). The 202 is
        // returned now; the switch finishes after the reconcile tick below.
        (async () => {
          await sleep(CUTOVER_TICK_MS);
          // The cutover set is the desired-state token: a concurrent shadow
          // rollback SREMs it. Bail early if it was superseded during the wait
          // so we skip the redundant config/rm churn entirely.
          if ((await app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId)) !== 1) return;
          await launch(engine, serverId, 'production');
        })().catch(async (err) => {
          // A supersession abort resolves (early `return`) and never lands here,
          // so this only fires on a genuine failure. log-ingest already dropped
          // this server's legacy tailer on SADD; without the SREM it would be
          // stranded with no publisher. Roll the desired state back to legacy.
          await app.redis.srem(RNSQUADJS_CUTOVER_SET, serverId).catch(() => undefined);
          log.error({ err, id: serverId }, 'sidecar switch failed; rolled back to legacy');
        });
        reply.code(202);
        return { server_id: serverId, engine, mode: 'production', status: 'switching' };
      }

      // Rollback: stand the shadow sidecar back up BEFORE SREM so the legacy
      // tailer only resumes once a publisher exists. A brief event gap is
      // acceptable; overlapping publishers (duplicates) are not.
      try {
        const containerId = await launch(engine, serverId, 'shadow');
        return { server_id: serverId, engine, mode: 'shadow', container_id: containerId };
      } finally {
        // SREM even when the relaunch throws: a dead sidecar with the legacy
        // tailer resumed is the safe degraded state. On a throw the error still
        // propagates after this (5xx), so the caller learns the relaunch failed.
        await app.redis.srem(RNSQUADJS_CUTOVER_SET, serverId);
      }
    },
  );
};

export default serverSidecarRoutes;
