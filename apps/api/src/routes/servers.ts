import { randomBytes } from 'node:crypto';
import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import {
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';
import { serverCreateInput } from '@squad/shared-types';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { fireAutoPrune } from '../lib/auto-prune.js';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { resolveRconHost } from '../lib/rcon-host.js';
import { rconSendOnce } from '../lib/rcon-send.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';
import { relaunchSidecar, sidecarContainerName } from '../lib/rnsquadjs.js';
import { softDeleteServer } from '../lib/server-delete.js';

const serverIdParams = z.object({ id: z.string().uuid() });

function containerName(id: string) {
  return `squad-${id}`;
}

const HOST_INFO_TTL_MS = 60_000;

const serverRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  let hostInfoCache: { value: { address: string; hostname: string }; at: number } | null = null;
  async function getHostAddress(): Promise<{ address: string; hostname: string } | null> {
    if (hostInfoCache && Date.now() - hostInfoCache.at < HOST_INFO_TTL_MS) {
      return hostInfoCache.value;
    }
    try {
      const info = await app.bridge.hostInfo();
      const value = { address: info.hostname, hostname: info.hostname };
      hostInfoCache = { value, at: Date.now() };
      return value;
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'hostInfo failed');
      return null;
    }
  }

  fast.get(
    '/api/v1/servers',
    {
      config: { permissions: ['server:view'], audit: false },
    },
    async () => {
      const rows = await app.db
        .select({
          id: servers.id,
          display_name: servers.displayName,
          slug: servers.slug,
          description: servers.description,
          status: servers.status,
          runtime: servers.runtime,
          tags: servers.tags,
          created_at: servers.createdAt,
          updated_at: servers.updatedAt,
        })
        .from(servers)
        .where(isNull(servers.deletedAt))
        .orderBy(servers.displayName);
      const items = await Promise.all(
        rows.map(async (r) => {
          const raw = await app.redis.get(`rcon:status:${r.id}`);
          let rconState: string | null = null;
          let playerCount: number | null = null;
          let lastPollAt: string | null = null;
          if (raw) {
            try {
              const s = JSON.parse(raw) as {
                state?: string;
                player_count?: number;
                last_poll_at?: string;
              };
              rconState = s.state ?? null;
              playerCount = typeof s.player_count === 'number' ? s.player_count : null;
              lastPollAt = s.last_poll_at ?? null;
            } catch {
              // ignore
            }
          }
          const a2sRaw = await app.redis.get(`a2s:status:${r.id}`);
          return {
            ...r,
            rcon_state: rconState,
            player_count: playerCount,
            last_poll_at: lastPollAt,
            a2s_status: a2sRaw ? (JSON.parse(a2sRaw) as unknown) : null,
            crash_loop: r.status === 'failed',
          };
        }),
      );
      return { items, total: items.length };
    },
  );

  fast.post(
    '/api/v1/servers',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'server.create', resource: 'server' },
      },
      schema: { body: serverCreateInput },
    },
    async (req, reply) => {
      const id = uuidv7();
      const body = req.body;

      // --- cross-server port collision check (mirrors PUT /:id/settings) ---
      const requestedPorts = [body.game_port, body.query_port, body.beacon_port, body.rcon_port];
      const conflictRows = await app.db
        .select({ serverId: serverSettings.serverId })
        .from(serverSettings)
        .innerJoin(servers, eq(serverSettings.serverId, servers.id))
        .where(
          and(
            isNull(servers.deletedAt),
            or(
              ...requestedPorts.map((p) =>
                or(
                  eq(serverSettings.gamePort, p),
                  eq(serverSettings.queryPort, p),
                  eq(serverSettings.beaconPort, p),
                  eq(serverSettings.rconPort, p),
                ),
              ),
            ),
          ),
        )
        .limit(1);

      if (conflictRows.length > 0) {
        reply.code(409);
        return {
          error: 'port_conflict',
          message: 'One or more ports are already in use by another server.',
        };
      }

      await app.db.transaction(async (tx) => {
        await tx.insert(servers).values({
          id,
          displayName: body.display_name,
          slug: body.slug,
          description: body.description ?? null,
          status: 'pending',
          runtime: 'container',
        });
        await tx.insert(serverSettings).values({
          serverId: id,
          installPath: `${PANEL_CONFIGS_ROOT}/${id}`,
          gamePort: body.game_port,
          queryPort: body.query_port,
          beaconPort: body.beacon_port,
          rconPort: body.rcon_port,
          maxPlayers: body.max_players ?? 100,
          tickrate: body.tickrate ?? 50,
          multihome: body.multihome ?? '0.0.0.0',
          extraArgs: body.extra_args ?? '',
          launchArgsOverride: body.launch_args_override ?? null,
          cpuAffinity: body.cpu_affinity ?? null,
          cpuWeight: body.cpu_weight ?? null,
          niceness: body.niceness ?? null,
          memoryHighMb: body.memory_high_mb ?? null,
          memoryMaxMb: body.memory_max_mb ?? null,
          ioWeight: body.io_weight ?? null,
        });
        const rconPassword = randomBytes(24).toString('base64url');
        const blob = encrypt(app.encryptionKey, rconPassword);
        // Leave rconHost unset so each downstream caller (api vs worker-rcon)
        // resolves it against its own RCON_HOST_DEFAULT env var at connect
        // time — see apps/workers/rcon/src/index.ts reconcile() and
        // server-configs.ts reloadServerConfig().
        await tx.insert(serverCredentials).values({
          serverId: id,
          rconPort: body.rcon_port,
          rconPasswordEncrypted: serialize(blob),
        });
      });
      reply.code(201);
      return { id, status: 'pending' };
    },
  );

  fast.get(
    '/api/v1/servers/:id',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const settingsRow = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, req.params.id),
      });
      const rconRaw = await app.redis.get(`rcon:status:${row.id}`);
      let rcon_status: {
        state: string;
        ts?: string;
        player_count?: number;
        last_poll_at?: string;
        backoffMs?: number;
        tickrate_rt?: number;
        current_map?: string;
      } = { state: 'not_polled' };
      if (rconRaw) {
        try {
          rcon_status = JSON.parse(rconRaw);
        } catch {
          rcon_status = { state: 'not_polled' };
        }
      }
      const a2sRaw = await app.redis.get(`a2s:status:${row.id}`);
      const a2s_status: unknown = a2sRaw ? (JSON.parse(a2sRaw) as unknown) : null;

      const name = containerName(row.id);
      const [inspect, host] = await Promise.all([
        app.bridge.containerInspect({ name }).catch((err) => {
          app.log.warn({ err: (err as Error).message, name }, 'containerInspect failed');
          return null;
        }),
        getHostAddress(),
      ]);

      const isAlive = !!inspect && inspect.state !== 'not_found' && inspect.running;
      const stats = isAlive
        ? await app.bridge.containerStats({ name }).catch((err) => {
            app.log.warn({ err: (err as Error).message, name }, 'containerStats failed');
            return null;
          })
        : null;

      const container =
        inspect && inspect.state !== 'not_found'
          ? {
              state: inspect.state,
              running: inspect.running,
              started_at: inspect.started_at || null,
              finished_at: inspect.finished_at || null,
              image: inspect.image || null,
              pid: inspect.pid || null,
              restart_count: inspect.restart_count,
              exit_code: inspect.exit_code,
              cpu_percent: stats?.found ? stats.cpu_percent : null,
              mem_used_bytes: stats?.found ? stats.mem_used_bytes : null,
              mem_limit_bytes: stats?.found ? stats.mem_limit_bytes : null,
              mem_percent: stats?.found ? stats.mem_percent : null,
              pids: stats?.found ? stats.pids : null,
            }
          : null;

      const crashRaw = await app.redis.zrevrange(`crashes:${row.id}`, 0, 9);
      const crash_history = crashRaw.map((c: string) => JSON.parse(c) as unknown);
      const crash_loop = row.status === 'failed';

      return {
        server: {
          id: row.id,
          display_name: row.displayName,
          slug: row.slug,
          description: row.description,
          status: row.status,
          runtime: row.runtime,
          container_id: row.containerId,
          tags: row.tags,
          timezone: row.timezone,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        },
        settings: settingsRow
          ? {
              server_id: settingsRow.serverId,
              install_path: settingsRow.installPath,
              game_port: settingsRow.gamePort,
              query_port: settingsRow.queryPort,
              beacon_port: settingsRow.beaconPort,
              rcon_port: settingsRow.rconPort,
              max_players: settingsRow.maxPlayers,
              tickrate: settingsRow.tickrate,
              multihome: settingsRow.multihome,
              extra_args: settingsRow.extraArgs,
            }
          : null,
        rcon_status,
        a2s_status,
        container,
        host,
        crash_history,
        crash_loop,
      };
    },
  );

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
        app.liveBus?.publish({
          type: 'server.status',
          ts: new Date().toISOString(),
          data: { server_id: s.id, status: 'starting', source: 'start' },
        });
        let containerId: string | null = s.containerId ?? null;
        if (inspect && inspect.state !== 'not_found') {
          await app.bridge.containerStart({ name });
        } else {
          const runRes = await app.bridge.containerRun({
            server_id: s.id,
            image: SERVER_IMAGE,
            game_port: settings.gamePort,
            query_port: settings.queryPort,
            beacon_port: settings.beaconPort,
            rcon_port: settings.rconPort,
            max_players: settings.maxPlayers,
            tickrate: settings.tickrate,
            multihome: settings.multihome,
            configs_host: `${PANEL_CONFIGS_ROOT}/${s.id}/ServerConfig`,
            saved_host: `${PANEL_SAVED_ROOT}/${s.id}`,
            depot_volume: DEPOT_VOLUME_NAME,
          });
          containerId = runRes.container_id;
        }
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
            'rnsquadjs sidecar relaunch on start failed (continuing)',
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
              deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
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
            await new Promise((resolve) => setTimeout(resolve, 15_000));
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
        // Stop the RNSquadJS sidecar too. It is not load-bearing for the
        // server lifecycle, so a failure here must not fail the stop.
        await app.bridge
          .containerStop({ name: sidecarContainerName(s.id), timeout_sec: 30 })
          .catch((err: unknown) => {
            req.log.warn(
              { err: (err as Error).message, id: s.id },
              'rnsquadjs sidecar stop failed (continuing)',
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
      await app.bridge.containerStop({ name, timeout_sec: 60 }).catch(() => {});
      await app.bridge.containerStart({ name });
      // The sidecar was not part of the restart, but a prior manual stop may
      // have left it down; relaunch it so a restarted cutover server keeps its
      // log publisher. Non-fatal: the squad container is already restarting.
      await relaunchSidecar(app, s.id).catch((err: unknown) => {
        req.log.warn(
          { err: (err as Error).message, id: s.id },
          'rnsquadjs sidecar relaunch on restart failed (continuing)',
        );
      });
      return { status: 'restarting' };
    },
  );

  fast.post(
    '/api/v1/servers/:id/reconcile',
    {
      config: {
        permissions: ['server:view'],
        audit: { action: 'server.reconcile', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
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

  fast.get(
    '/api/v1/servers/:id/events',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: {
        params: serverIdParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
        columns: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const stream = `events:server:${req.params.id}`;
      const raw = (await app.redis.xrevrange(stream, '+', '-', 'COUNT', req.query.limit)) as Array<
        [string, string[]]
      >;
      const items: Array<{
        stream_id: string;
        event_id: string;
        type: string;
        ts: string;
        payload: unknown;
      }> = [];
      for (const [streamId, kv] of raw) {
        const envIdx = kv.indexOf('envelope');
        if (envIdx < 0 || envIdx + 1 >= kv.length) continue;
        const rawEnv = kv[envIdx + 1];
        if (!rawEnv) continue;
        try {
          const env = JSON.parse(rawEnv) as {
            event_id: string;
            type: string;
            ts: string;
            payload: unknown;
          };
          items.push({
            stream_id: streamId,
            event_id: env.event_id,
            type: env.type,
            ts: env.ts,
            payload: env.payload,
          });
        } catch {
          // ignore bad envelopes
        }
      }
      return { items, total: items.length };
    },
  );

  fast.delete(
    '/api/v1/servers/:id',
    {
      config: {
        permissions: ['server:delete'],
        audit: { action: 'server.delete', resource: 'server' },
      },
      schema: { params: serverIdParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const actorPlayerId = req.user?.playerId;
      const softDeleteT0 = Date.now();
      await req.diag.emit({
        component: 'api',
        kind: 'server.soft_delete.requested',
        severity: 'info',
        serverId: row.id,
        actorPlayerId,
        message: 'soft-delete requested',
        payload: {},
      });
      try {
        const result = await softDeleteServer(
          {
            db: app.db,
            bridge: app.bridge,
            log: req.log,
            actorPlayerId: req.user?.playerId ?? null,
            actorIp: req.ip ?? null,
            actorLabel: req.user ? `player:${req.user.playerId}` : 'system',
          },
          row.id,
        );
        app.liveBus.publish({
          type: 'server.deleted',
          ts: new Date().toISOString(),
          data: {
            server_id: row.id,
            deleted_at: new Date().toISOString(),
            by: req.user?.playerId ?? null,
          },
        });
        await req.diag.emit({
          component: 'api',
          kind: 'server.soft_delete.done',
          severity: 'info',
          serverId: row.id,
          actorPlayerId,
          message: 'soft-delete complete',
          payload: {
            backup_id: result.backup_marker_id,
            files_backed_up: result.files_backed_up,
            durationMs: Date.now() - softDeleteT0,
          },
        });
        // Spec §"deleted means deleted": after the per-server cleanup
        // succeeded we additionally reclaim docker build cache and any
        // dangling images that the squad-server stack left behind. Fire
        // and forget — the response to the operator returns immediately
        // and the prune logs/audits when it completes.
        fireAutoPrune(app, `server.delete:${row.id}`, req.user?.playerId ?? null, req.ip ?? null);
        return { ok: true, ...result };
      } catch (err) {
        const errorMessage = (err as Error).message;
        await req.diag.emit({
          component: 'api',
          kind: 'server.soft_delete.failed',
          severity: 'error',
          serverId: row.id,
          actorPlayerId,
          message: `soft-delete failed: ${errorMessage}`,
          payload: { errorMessage, durationMs: Date.now() - softDeleteT0 },
        });
        reply.code(500);
        return { error: 'delete_failed', message: errorMessage };
      }
    },
  );
};

export default serverRoutes;
