import { serverSettings, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { relaunchSidecar } from '../../lib/rnsquadjs.js';
import { runFreshServerContainer } from '../../lib/server-container.js';
import { isExternalRuntime, rejectExternalServer } from '../../lib/server-runtime.js';
import { containerName, isDepotUpdating, serverIdParams } from '../../lib/servers/common.js';

/** Server start, restart and reconcile. */
const serverStartRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/start',
    {
      config: {
        permissions: ['server:start'],
        audit: { action: 'server.start', resource: 'server' },
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
      if (isExternalRuntime(s.runtime)) return rejectExternalServer(reply);
      if (await isDepotUpdating(app.redis)) {
        reply.code(409);
        return { error: 'depot_update_in_progress' };
      }
      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, s.id),
      });
      if (!settings) {
        reply.code(400);
        return { error: 'server_not_installed' };
      }
      const actorPlayerId = req.user?.playerId;
      const startT0 = Date.now();
      await req.diag.emit({
        component: 'api',
        kind: 'server.start.requested',
        severity: 'info',
        serverId: s.id,
        actorPlayerId,
        message: 'start requested',
        payload: {},
      });
      const name = containerName(s.id);
      try {
        const inspect = await app.bridge.containerInspect({ name }).catch(() => null);
        if (inspect?.running) {
          await app.db
            .update(servers)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(servers.id, s.id));
          await req.diag.emit({
            component: 'api',
            kind: 'server.start.done',
            severity: 'info',
            serverId: s.id,
            actorPlayerId,
            message: 'already running',
            payload: { durationMs: Date.now() - startT0, container_id: s.containerId ?? null },
          });
          return { status: 'running', note: 'already running' };
        }
        // Eager flip + LiveEvent BEFORE container_run/start: if the api process
        // crashes mid-bridge-call the row stays 'starting' and the reconciler
        // converges it to 'running'/'stopped' on the next tick.
        await app.db
          .update(servers)
          .set({ status: 'starting', updatedAt: new Date() })
          .where(eq(servers.id, s.id));
        // Re-check the depot lock we already checked above (#20 follow-up):
        // the initial check plus the containerInspect round-trip left a
        // window where a depot update could see this server as
        // 'stopped'/'ready' and proceed. Whichever side observes the other
        // first now wins — depot/update's own servers_running check (which
        // includes 'starting') catches us if it acquires the lock first, and
        // this recheck catches it if we flip to 'starting' first — so no
        // interleaving lets both sides through.
        if (await isDepotUpdating(app.redis)) {
          await app.db
            .update(servers)
            .set({ status: s.status, updatedAt: new Date() })
            .where(eq(servers.id, s.id));
          reply.code(409);
          return { error: 'depot_update_in_progress' };
        }
        app.liveBus?.publish({
          type: 'server.status',
          ts: new Date().toISOString(),
          data: { server_id: s.id, status: 'starting', source: 'start' },
        });
        const containerId = await runFreshServerContainer(
          app.bridge,
          s.id,
          settings,
          inspect !== null && inspect.state !== 'not_found',
        );
        await req.diag.emit({
          component: 'api',
          kind: 'server.start.done',
          severity: 'info',
          serverId: s.id,
          actorPlayerId,
          message: 'start succeeded',
          payload: { durationMs: Date.now() - startT0, container_id: containerId },
        });
        // A manual stop disables docker's restart policy on the sidecar, so a
        // stop→start cycle leaves a cutover server with no log publisher unless
        // we relaunch it here. Non-fatal: the squad container is already up.
        await relaunchSidecar(app, s.id).catch((err: unknown) => {
          req.log.warn(
            { err: (err as Error).message, id: s.id },
            'sidecar relaunch on start failed (continuing)',
          );
        });
        return { status: 'starting' };
      } catch (err) {
        const errorMessage = (err as Error).message;
        await req.diag.emit({
          component: 'api',
          kind: 'server.start.failed',
          severity: 'error',
          serverId: s.id,
          actorPlayerId,
          message: `start failed: ${errorMessage}`,
          payload: { errorMessage, durationMs: Date.now() - startT0 },
        });
        throw err;
      }
    },
  );

  fast.post(
    '/api/v1/servers/:id/restart',
    {
      config: {
        permissions: ['server:restart'],
        audit: { action: 'server.restart', resource: 'server' },
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
      if (isExternalRuntime(s.runtime)) return rejectExternalServer(reply);
      if (await isDepotUpdating(app.redis)) {
        reply.code(409);
        return { error: 'depot_update_in_progress' };
      }
      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, s.id),
      });
      if (!settings) {
        reply.code(400);
        return { error: 'server_not_installed' };
      }
      const actorPlayerId = req.user?.playerId;
      const restartT0 = Date.now();
      await req.diag.emit({
        component: 'api',
        kind: 'server.restart.requested',
        severity: 'info',
        serverId: s.id,
        actorPlayerId,
        message: 'restart requested',
        payload: {},
      });
      const name = containerName(s.id);
      await app.db
        .update(servers)
        .set({ status: 'starting', updatedAt: new Date() })
        .where(eq(servers.id, s.id));
      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: s.id, status: 'starting', source: 'restart' },
      });
      try {
        const inspect = await app.bridge.containerInspect({ name }).catch(() => null);
        if (inspect?.state === 'not_found') {
          // Removed out of band: recreate it, as /start does.
          await runFreshServerContainer(app.bridge, s.id, settings, false);
        } else {
          try {
            await app.bridge.containerStop({ name, timeout_sec: 60 });
          } catch (stopErr) {
            req.log.warn(
              { err: (stopErr as Error).message, id: s.id },
              'container_stop failed during restart',
            );
            // `docker start` on a still-running container does nothing, so a
            // failed stop that left it up must not be reported as a restart.
            const after = await app.bridge.containerInspect({ name }).catch(() => null);
            if (after?.running !== false) {
              await app.db
                .update(servers)
                .set({ status: 'running', updatedAt: new Date() })
                .where(eq(servers.id, s.id));
              await req.diag.emit({
                component: 'api',
                kind: 'server.restart.failed',
                severity: 'error',
                serverId: s.id,
                actorPlayerId,
                message: `restart failed: container_stop: ${(stopErr as Error).message}`,
                payload: {
                  stage: 'container_stop',
                  errorMessage: (stopErr as Error).message,
                  durationMs: Date.now() - restartT0,
                },
              });
              reply.code(502);
              return {
                error: 'container_stop_failed',
                message: 'The container could not be stopped, so it was not restarted.',
              };
            }
          }
          // Recreated from the current settings: a plain `containerStart`
          // would keep the ports and slots the container was created with.
          await runFreshServerContainer(app.bridge, s.id, settings, true);
        }
      } catch (err) {
        const errorMessage = (err as Error).message;
        await req.diag.emit({
          component: 'api',
          kind: 'server.restart.failed',
          severity: 'error',
          serverId: s.id,
          actorPlayerId,
          message: `restart failed: ${errorMessage}`,
          payload: { errorMessage, durationMs: Date.now() - restartT0 },
        });
        throw err;
      }
      await req.diag.emit({
        component: 'api',
        kind: 'server.restart.done',
        severity: 'info',
        serverId: s.id,
        actorPlayerId,
        message: 'restart succeeded',
        payload: { durationMs: Date.now() - restartT0 },
      });
      // The sidecar was not part of the restart, but a prior manual stop may
      // have left it down; relaunch it so a restarted cutover server keeps its
      // log publisher. Non-fatal: the squad container is already restarting.
      await relaunchSidecar(app, s.id).catch((err: unknown) => {
        req.log.warn(
          { err: (err as Error).message, id: s.id },
          'sidecar relaunch on restart failed (continuing)',
        );
      });
      return { status: 'restarting' };
    },
  );

  fast.post(
    '/api/v1/servers/:id/reconcile',
    {
      config: {
        // Triggers a bridge containerInspect call, a DB status write, a
        // live-event publish, and an audit entry — a mutating action, so it
        // requires a mutating permission, not the read-only server:view.
        permissions: ['server:restart'],
        audit: { action: 'server.reconcile', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const target = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
        columns: { runtime: true },
      });
      if (target && isExternalRuntime(target.runtime)) return rejectExternalServer(reply);
      try {
        const result = await app.statusReconciler.reconcileOnce(req.params.id);
        if (!result) {
          reply.code(404);
          return { error: 'not_found' };
        }
        return result;
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message, serverId: req.params.id },
          'manual reconcile failed',
        );
        reply.code(502);
        return { error: 'bridge_unavailable', message: (err as Error).message };
      }
    },
  );
};

export default serverStartRoutes;
