import { serverSettings, servers } from '@squad/db/schema';
import {
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Manages the shared `squad-depot` Docker volume that holds Squad game
 * binaries. One-time initial population and subsequent upgrades both go
 * through the bridge's depot_update RPC, which spawns a transient
 * steamcmd container. Progress streams through a Redis pub/sub channel
 * so multiple UI tabs can watch the same update.
 */

const DEPOT_MARKER = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGameServer.sh`;
const DEPOT_MANIFEST = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/steamapps/appmanifest_403240.acf`;

const depotUpdateBody = z
  .object({
    server_ids: z.array(z.string().uuid()).optional().default([]),
  })
  .strict()
  .default({});

function parseBuildId(manifest: string): string | null {
  const m = /"buildid"\s+"(\d+)"/.exec(manifest);
  return m?.[1] ?? null;
}

const depotRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/depot', { config: { permissions: ['server:view'], audit: false } }, async () => {
    let populated = false;
    let buildId: string | null = null;
    try {
      await app.bridge.fileRead({ path: DEPOT_MARKER });
      populated = true;
    } catch {
      populated = false;
    }
    if (populated) {
      try {
        const { content } = await app.bridge.fileRead({ path: DEPOT_MANIFEST });
        buildId = parseBuildId(content);
      } catch {
        buildId = null;
      }
    }
    const redisBuildId = await app.redis.get('depot:build_id');
    const lastUpdateRaw = await app.redis.get('depot:last_update');
    return {
      volume: DEPOT_VOLUME_NAME,
      populated,
      build_id: redisBuildId ?? buildId,
      last_update: lastUpdateRaw ? JSON.parse(lastUpdateRaw) : null,
    };
  });

  app.post(
    '/api/v1/depot/update',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'depot.update', resource: 'depot' },
      },
    },
    async (req, reply) => {
      const parsed = depotUpdateBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation_error', details: parsed.error.issues };
      }
      const { server_ids: serverIds } = parsed.data;

      // Validate that all requested server IDs exist and are not deleted.
      if (serverIds.length > 0) {
        const found = await app.db
          .select({ id: servers.id, status: servers.status })
          .from(servers)
          .where(and(inArray(servers.id, serverIds), isNull(servers.deletedAt)));

        if (found.length !== serverIds.length) {
          const foundIds = new Set(found.map((r) => r.id));
          const missing = serverIds.filter((id) => !foundIds.has(id));
          reply.code(400);
          return { error: 'servers_not_found', missing };
        }
      }

      const startedAt = new Date().toISOString();
      const acquired = await app.redis.set('depot:updating', startedAt, 'EX', 3600, 'NX');
      if (!acquired) {
        const since = await app.redis.get('depot:updating');
        return { status: 'already_in_progress', since: since ?? startedAt };
      }

      // Background orchestration: stop servers → update depot → restart servers.
      (async () => {
        const dedicated = app.makeBridgeClient();
        const stoppedIds: string[] = [];

        /** Restart each stopped server via containerStart, falling back to containerRun. */
        async function restartServers(ids: string[]) {
          for (const sid of ids) {
            try {
              void app.redis.xadd(
                'depot:progress',
                'MAXLEN',
                '~',
                '5000',
                '*',
                'stream',
                'stdout',
                'text',
                `Restarting server squad-${sid} …`,
              );
              try {
                await app.bridge.containerStart({ name: `squad-${sid}` });
              } catch {
                // containerStart failed — container might have been removed; try containerRun.
                const settings = await app.db.query.serverSettings.findFirst({
                  where: eq(serverSettings.serverId, sid),
                });
                if (settings) {
                  await app.bridge.containerRun({
                    server_id: sid,
                    image: SERVER_IMAGE,
                    game_port: settings.gamePort,
                    query_port: settings.queryPort,
                    beacon_port: settings.beaconPort,
                    rcon_port: settings.rconPort,
                    max_players: settings.maxPlayers,
                    tickrate: settings.tickrate,
                    multihome: settings.multihome,
                    configs_host: `${PANEL_CONFIGS_ROOT}/${sid}/ServerConfig`,
                    saved_host: `${PANEL_SAVED_ROOT}/${sid}`,
                    depot_volume: DEPOT_VOLUME_NAME,
                  });
                }
              }
              await app.db
                .update(servers)
                .set({ status: 'starting', updatedAt: new Date() })
                .where(eq(servers.id, sid));
            } catch {
              // Best-effort restart; don't abort the loop for one failure.
            }
          }
        }

        try {
          await dedicated.connect();

          // ── Phase 1: stop requested servers ──
          for (const sid of serverIds) {
            try {
              void app.redis.xadd(
                'depot:progress',
                'MAXLEN',
                '~',
                '5000',
                '*',
                'stream',
                'stdout',
                'text',
                `Stopping server squad-${sid} …`,
              );
              await app.bridge.containerStop({ name: `squad-${sid}`, timeout_sec: 60 });
              await app.db
                .update(servers)
                .set({ status: 'stopped', updatedAt: new Date() })
                .where(eq(servers.id, sid));
              stoppedIds.push(sid);
            } catch {
              // Best-effort; continue with remaining servers.
            }
          }

          // ── Phase 2: run SteamCMD depot update ──
          await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            void app.redis.xadd(
              'depot:progress',
              'MAXLEN',
              '~',
              '5000',
              '*',
              'stream',
              frame.stream,
              'text',
              text,
            );
          });

          // ── Phase 3: store build ID from manifest ──
          try {
            const { content } = await app.bridge.fileRead({ path: DEPOT_MANIFEST });
            const bid = parseBuildId(content);
            if (bid) {
              await app.redis.set('depot:build_id', bid);
            }
          } catch {
            // Non-fatal: manifest may not be readable yet.
          }

          await app.redis.set(
            'depot:last_update',
            JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
          );

          // ── Phase 4: restart previously stopped servers ──
          await restartServers(stoppedIds);
        } catch (err) {
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({
              finished_at: new Date().toISOString(),
              status: 'failed',
              error: (err as Error).message,
            }),
          );
          // Even on failure, restart any servers we stopped — never leave them down.
          await restartServers(stoppedIds);
        } finally {
          await app.redis.del('depot:updating');
          await dedicated.close().catch(() => undefined);
        }
      })();

      return {
        status: 'started',
        started_at: startedAt,
        servers_to_stop: serverIds,
      };
    },
  );

  app.get(
    '/api/v1/depot/progress/ws',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket) => {
      let closed = false;
      let lastId = '0';
      void (async () => {
        try {
          const backfill = (await app.redis.xrange(
            'depot:progress',
            '-',
            '+',
            'COUNT',
            '500',
          )) as Array<[string, string[]]>;
          for (const [id, kv] of backfill) {
            lastId = id;
            const idx = kv.indexOf('text');
            if (idx < 0) continue;
            const stream = kv[kv.indexOf('stream') + 1] ?? 'stdout';
            const text = kv[idx + 1] ?? '';
            socket.send(JSON.stringify({ ts: new Date().toISOString(), stream, message: text }));
          }
          while (!closed) {
            const res = (await app.redis.xread(
              'BLOCK',
              '5000',
              'STREAMS',
              'depot:progress',
              lastId,
            )) as Array<[string, Array<[string, string[]]>]> | null;
            if (!res) continue;
            for (const [, entries] of res) {
              for (const [id, kv] of entries) {
                lastId = id;
                const idx = kv.indexOf('text');
                if (idx < 0) continue;
                const stream = kv[kv.indexOf('stream') + 1] ?? 'stdout';
                const text = kv[idx + 1] ?? '';
                socket.send(
                  JSON.stringify({ ts: new Date().toISOString(), stream, message: text }),
                );
              }
            }
          }
        } catch {
          // socket gone
        }
      })();
      socket.on('close', () => {
        closed = true;
      });
    },
  );
};

export default depotRoutes;
