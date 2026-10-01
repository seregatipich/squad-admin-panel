import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { resolveRconHost } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { decryptString, deserialize } from '../../lib/crypto.js';
import { rconSendOnce } from '../../lib/rcon-send.js';
import { sendRconCommandViaWorker } from '../../lib/rcon-worker-command.js';
import { isExternalRuntime, rejectExternalServer } from '../../lib/server-runtime.js';
import { containerName, serverIdParams } from '../../lib/servers/common.js';
import { stopSidecar } from '../../lib/sidecar-lifecycle.js';

/** Server stop. */
const serverStopRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/stop',
    {
      config: {
        permissions: ['server:stop'],
        audit: { action: 'server.stop', resource: 'server' },
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

      const settings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, s.id),
      });
      const creds = await app.db.query.serverCredentials.findFirst({
        where: eq(serverCredentials.serverId, s.id),
      });

      const actorPlayerId = req.user?.playerId;
      const stopT0 = Date.now();
      // Mark requested-vs-unexpected exit window so the reconciler (status-
      // reconciler.ts) can distinguish a planned stop from a crash. TTL 5 min
      // matches the longest expected graceful-stop sequence.
      await app.redis.set(`stop:requested:${s.id}`, '1', 'EX', 300);
      await req.diag.emit({
        component: 'api',
        kind: 'server.stop.requested',
        severity: 'info',
        serverId: s.id,
        actorPlayerId,
        message: 'stop requested',
        payload: { method: 'graceful' },
      });

      try {
        // Mark 'stopping' BEFORE the slow RCON+stop sequence so the UI gets
        // immediate feedback and a process crash mid-flight leaves a state the
        // reconciler can resolve. The reconciler treats 'stopping' as transient
        // and will flip it to 'stopped' as soon as Docker reports exit.
        await app.db
          .update(servers)
          .set({ status: 'stopping', updatedAt: new Date() })
          .where(eq(servers.id, s.id));
        app.liveBus?.publish({
          type: 'server.status',
          ts: new Date().toISOString(),
          data: { server_id: s.id, status: 'stopping', source: 'stop' },
        });

        // Graceful shutdown (TZ §17.7): broadcast → end match → stop container.
        if (settings && creds) {
          try {
            const password = decryptString(
              app.encryptionKey,
              deserialize(Buffer.from(creds.rconPasswordEncrypted)),
            );
            const target = {
              host: resolveRconHost(creds.rconHost),
              port: creds.rconPort,
              password,
            };
            const broadcastT0 = Date.now();
            let broadcastOk = true;
            let broadcastResponse: string | undefined;
            let broadcastVia: 'worker-rcon' | 'direct' = 'direct';
            let broadcastRequestId: string | undefined;
            try {
              const viaWorker = await sendRconCommandViaWorker(app.redis, {
                serverId: s.id,
                command: 'AdminBroadcast',
                args: ['Server is shutting down in 15 seconds'],
                actorPlayerId,
                timeoutMs: 3000,
              });
              if (viaWorker.attempted) {
                broadcastVia = 'worker-rcon';
                broadcastRequestId = viaWorker.requestId;
                if (viaWorker.ok) {
                  broadcastResponse = viaWorker.response;
                } else {
                  broadcastOk = false;
                  broadcastResponse = viaWorker.detail ?? viaWorker.reason;
                  req.log.warn(
                    {
                      reason: viaWorker.reason,
                      detail: viaWorker.detail,
                      requestId: viaWorker.requestId,
                    },
                    'AdminBroadcast worker-rcon failed; not retrying directly',
                  );
                }
              } else {
                const r = await rconSendOnce({
                  ...target,
                  command: 'AdminBroadcast Server is shutting down in 15 seconds',
                  connectTimeoutMs: 2000,
                  commandTimeoutMs: 3000,
                });
                broadcastResponse = typeof r === 'string' ? r : undefined;
              }
            } catch (err) {
              broadcastOk = false;
              req.log.warn({ err: (err as Error).message }, 'AdminBroadcast failed; continuing');
              broadcastResponse = (err as Error).message;
            }
            await req.diag.emit({
              component: 'api',
              kind: 'server.stop.broadcast',
              severity: broadcastOk ? 'info' : 'error',
              serverId: s.id,
              actorPlayerId,
              message: broadcastOk ? 'AdminBroadcast sent' : 'AdminBroadcast failed',
              payload: {
                ok: broadcastOk,
                via: broadcastVia,
                requestId: broadcastRequestId,
                raw_response: broadcastResponse,
                durationMs: Date.now() - broadcastT0,
              },
            });
            // Nobody was warned when the broadcast failed, so waiting out the grace period is pointless.
            if (broadcastOk) await new Promise((resolve) => setTimeout(resolve, 15_000));
            const endMatchT0 = Date.now();
            let endMatchOk = true;
            let endMatchVia: 'worker-rcon' | 'direct' = 'direct';
            let endMatchRequestId: string | undefined;
            let endMatchResponse: string | undefined;
            try {
              const viaWorker = await sendRconCommandViaWorker(app.redis, {
                serverId: s.id,
                command: 'AdminEndMatch',
                actorPlayerId,
                timeoutMs: 3000,
              });
              if (viaWorker.attempted) {
                endMatchVia = 'worker-rcon';
                endMatchRequestId = viaWorker.requestId;
                if (viaWorker.ok) {
                  endMatchResponse = viaWorker.response;
                } else {
                  endMatchOk = false;
                  endMatchResponse = viaWorker.detail ?? viaWorker.reason;
                  req.log.warn(
                    {
                      reason: viaWorker.reason,
                      detail: viaWorker.detail,
                      requestId: viaWorker.requestId,
                    },
                    'AdminEndMatch worker-rcon failed; not retrying directly',
                  );
                }
              } else {
                await rconSendOnce({
                  ...target,
                  command: 'AdminEndMatch',
                  connectTimeoutMs: 2000,
                  commandTimeoutMs: 3000,
                });
              }
            } catch (err) {
              endMatchOk = false;
              req.log.warn({ err: (err as Error).message }, 'AdminEndMatch failed; continuing');
            }
            await req.diag.emit({
              component: 'api',
              kind: 'server.stop.end_match',
              severity: endMatchOk ? 'info' : 'error',
              serverId: s.id,
              actorPlayerId,
              message: endMatchOk ? 'AdminEndMatch sent' : 'AdminEndMatch failed',
              payload: {
                ok: endMatchOk,
                via: endMatchVia,
                requestId: endMatchRequestId,
                raw_response: endMatchResponse,
                durationMs: Date.now() - endMatchT0,
              },
            });
          } catch (err) {
            req.log.warn({ err: (err as Error).message }, 'graceful stop RCON phase skipped');
          }
        }

        const containerStopT0 = Date.now();
        let containerStopOk = true;
        try {
          await app.bridge.containerStop({ name: containerName(s.id), timeout_sec: 60 });
        } catch (err) {
          containerStopOk = false;
          await req.diag.emit({
            component: 'api',
            kind: 'server.stop.container_stop',
            severity: 'error',
            serverId: s.id,
            actorPlayerId,
            message: `container_stop failed: ${(err as Error).message}`,
            payload: {
              ok: false,
              errorMessage: (err as Error).message,
              durationMs: Date.now() - containerStopT0,
            },
          });
          throw err;
        }
        await req.diag.emit({
          component: 'api',
          kind: 'server.stop.container_stop',
          severity: 'info',
          serverId: s.id,
          actorPlayerId,
          message: 'container_stop succeeded',
          payload: { ok: containerStopOk, durationMs: Date.now() - containerStopT0 },
        });
        // Stop the sidecar too. It is not load-bearing for the server
        // lifecycle, so a failure here must not fail the stop.
        await stopSidecar(app.bridge, s.id, (err) => {
          req.log.warn(
            { err: (err as Error).message, id: s.id },
            'sidecar stop failed (continuing)',
          );
        });
        await req.diag.emit({
          component: 'api',
          kind: 'server.stop.done',
          severity: 'info',
          serverId: s.id,
          actorPlayerId,
          message: 'stop complete',
          payload: { totalDurationMs: Date.now() - stopT0 },
        });
        return { status: 'stopping' };
      } catch (err) {
        const errorMessage = (err as Error).message;
        await req.diag.emit({
          component: 'api',
          kind: 'server.stop.failed',
          severity: 'error',
          serverId: s.id,
          actorPlayerId,
          message: `stop failed: ${errorMessage}`,
          payload: {
            stage: 'container_stop',
            errorMessage,
            totalDurationMs: Date.now() - stopT0,
          },
        });
        throw err;
      }
    },
  );
};

export default serverStopRoutes;
