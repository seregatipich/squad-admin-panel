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
import {
  DEPOT_PROGRESS_STREAM,
  publishDepotProgressDone,
  publishDepotProgressLine,
} from '../lib/depot-progress.js';

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
              // Best-effort: a dropped progress line must not skip the actual
              // restart below, so its failure is logged, not thrown.
              await publishDepotProgressLine(
                app.redis,
                'stdout',
                `Restarting server squad-${sid} …`,
              ).catch((error: unknown) => {
                app.log.error(
                  { err: error, server_id: sid },
                  'failed to publish restart progress line',
                );
              });
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

        let finalStatus: 'done' | 'error' = 'done';
        let finalError: string | undefined;
        try {
          await dedicated.connect();

          // ── Phase 1: stop requested servers ──
          for (const sid of serverIds) {
            try {
              // Best-effort: a dropped progress line must not skip the actual
              // stop below, so its failure is logged, not thrown.
              await publishDepotProgressLine(
                app.redis,
                'stdout',
                `Stopping server squad-${sid} …`,
              ).catch((error: unknown) => {
                app.log.error(
                  { err: error, server_id: sid },
                  'failed to publish stop progress line',
                );
              });
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
          // Each progress line is awaited (not fired-and-forgotten): a silently
          // dropped xadd would leave depot:last_update=ok even though a
          // progress frame never made it to the stream.
          const steamCmdStreamWrites: Promise<void>[] = [];
          const steamCmdStreamWriteErrors: unknown[] = [];
          await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            steamCmdStreamWrites.push(
              publishDepotProgressLine(app.redis, frame.stream, text).catch((error: unknown) => {
                steamCmdStreamWriteErrors.push(error);
              }),
            );
          });
          await Promise.all(steamCmdStreamWrites);
          if (steamCmdStreamWriteErrors.length > 0) throw steamCmdStreamWriteErrors[0];

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
          // Even on failure, restart any servers we stopped — never leave them down.
          await restartServers(stoppedIds);
        } finally {
          await publishDepotProgressDone(app.redis, finalStatus, finalError).catch(
            (error: unknown) => {
              app.log.error({ err: error }, 'failed to publish depot update completion event');
            },
          );
          await app.redis.del('depot:updating').catch((error: unknown) => {
            app.log.error({ err: error }, 'failed to release depot update lock');
          });
          await dedicated.close().catch((error: unknown) => {
            app.log.error({ err: error }, 'failed to close depot bridge client');
          });
        }
      })().catch((error: unknown) => {
        app.log.error({ err: error }, 'unexpected depot update background error');
      });

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
      // A blocking XREAD occupies the connection it runs on until data
      // arrives or the block times out — issuing it on the shared app.redis
      // singleton would queue every other route's Redis command behind it
      // for up to 5s at a time. Each connection gets its own duplicate,
      // matching the pattern in plugins/live-bus.ts.
      const redis = app.redis.duplicate();
      redis.on('error', () => {
        // connection lost; the read loop's catch block ends the socket.
      });

      // Sends one stream entry. Entries written by publishDepotProgressDone
      // (`stream: 'event'`) carry a pre-encoded {done,final,error?} object and
      // are forwarded verbatim; returns true for those so the caller can tell
      // a terminal frame was sent. Ordinary stdout/stderr lines are wrapped
      // and always return false.
      function sendEntry(kv: string[]): boolean {
        const idx = kv.indexOf('text');
        if (idx < 0) return false;
        const stream = kv[kv.indexOf('stream') + 1] ?? 'stdout';
        const text = kv[idx + 1] ?? '';
        if (stream === 'event') {
          socket.send(text);
          return true;
        }
        socket.send(JSON.stringify({ ts: new Date().toISOString(), stream, message: text }));
        return false;
      }

      void (async () => {
        try {
          // Backfill may span a prior, already-finished run followed by the
          // run the client just triggered — a 'done' seen here isn't
          // necessarily current, so it's forwarded (for context) but never
          // treated as terminal. Only 'done' frames seen live, after
          // `backfill_complete`, end the connection.
          const backfill = (await redis.xrange(
            DEPOT_PROGRESS_STREAM,
            '-',
            '+',
            'COUNT',
            '500',
          )) as Array<[string, string[]]>;
          for (const [id, kv] of backfill) {
            lastId = id;
            sendEntry(kv);
          }
          socket.send(JSON.stringify({ backfill_complete: true }));

          // If no update is running right now, the run the client just
          // triggered may have already finished (or none is in flight at
          // all) between their POST and this WS connecting — synthesize a
          // terminal frame from the last known result instead of blocking
          // on a live event that will never arrive.
          const updating = await redis.get('depot:updating');
          if (!updating) {
            const lastUpdateRaw = await redis.get('depot:last_update');
            if (lastUpdateRaw) {
              const lastUpdate = JSON.parse(lastUpdateRaw) as {
                status: 'ok' | 'failed';
                error?: string;
              };
              socket.send(
                JSON.stringify(
                  lastUpdate.status === 'ok'
                    ? { done: true, final: 'done' }
                    : { done: true, final: 'error', error: lastUpdate.error },
                ),
              );
              socket.close();
              return;
            }
          }

          while (!closed) {
            const res = (await redis.xread(
              'BLOCK',
              '5000',
              'STREAMS',
              DEPOT_PROGRESS_STREAM,
              lastId,
            )) as Array<[string, Array<[string, string[]]>]> | null;
            if (!res) continue;
            for (const [, entries] of res) {
              for (const [id, kv] of entries) {
                lastId = id;
                if (sendEntry(kv)) {
                  socket.close();
                  return;
                }
              }
            }
          }
        } catch {
          // socket gone
        } finally {
          redis.disconnect();
        }
      })();
      socket.on('close', () => {
        closed = true;
        // Forcibly tears down an in-flight blocking XREAD so a client that
        // disconnects mid-block doesn't leave the duplicate connection open
        // for up to another 5s waiting on data nobody will read.
        redis.disconnect();
      });
    },
  );
};

export default depotRoutes;
