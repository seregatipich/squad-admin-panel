import { serverSettings, servers } from '@squad/db/schema';
import { DEPOT_VOLUME_NAME } from '@squad/shared-config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { acquireDepotLock, DEPOT_LOCK_KEY, depotLockStartedAt } from '../lib/depot-lock.js';
import {
  DEPOT_PROGRESS_STREAM,
  publishDepotProgressDone,
  publishDepotProgressLine,
} from '../lib/depot-progress.js';
import { runFreshServerContainer } from '../lib/server-container.js';
import { sendUnlessStalled } from '../lib/ws-send.js';
import {
  createStreamLimiter,
  streamCallerKey,
  WS_CLOSE_TRY_AGAIN_LATER,
} from '../lib/ws-stream-limit.js';

/**
 * Manages the shared `squad-depot` Docker volume that holds Squad game
 * binaries. One-time initial population and subsequent upgrades both go
 * through the bridge's depot_update RPC, which spawns a transient
 * steamcmd container. Progress streams through a Redis pub/sub channel
 * so multiple UI tabs can watch the same update.
 */

/**
 * Statuses in which a container server has (or is about to have) the shared
 * depot volume mounted by a live process, mirroring server-update.ts's
 * per-server guard (#20 follow-up).
 */
const LIVE_STATUSES = ['installing', 'starting', 'running', 'stopping'];

const DEPOT_MARKER = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGameServer.sh`;
const DEPOT_MANIFEST = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/steamapps/appmanifest_403240.acf`;

const depotUpdateBody = z
  .object({
    server_ids: z.array(z.string().uuid()).optional().default([]),
  })
  .strict()
  .default({});

/**
 * Server statuses whose container is up (or coming up) and must be stopped
 * for the update and started again after it. Any other requested server is
 * left untouched: restarting it would bring up a server the operator chose to
 * keep down.
 */
const RESTARTABLE_STATUSES = new Set(['running', 'starting']);
/** Depot progress sockets one caller may hold open at once (#1298). */
export const DEPOT_STREAMS_PER_CALLER = 4;
/** Depot progress sockets this API process holds open at once (#1298). */
const DEPOT_STREAMS_TOTAL = 32;

function parseBuildId(manifest: string): string | null {
  const m = /"buildid"\s+"(\d+)"/.exec(manifest);
  return m?.[1] ?? null;
}

const depotRoutes: FastifyPluginAsync = async (app) => {
  // Each progress socket owns a duplicate Redis connection for its blocking
  // XREAD, so the socket count is capped (#1298).
  const progressStreams = createStreamLimiter({
    perCaller: DEPOT_STREAMS_PER_CALLER,
    total: DEPOT_STREAMS_TOTAL,
  });
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
      const serversToStop: string[] = [];
      const serversSkipped: string[] = [];
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
        const statusById = new Map(found.map((row) => [row.id, row.status]));
        for (const id of serverIds) {
          if (RESTARTABLE_STATUSES.has(statusById.get(id) ?? '')) serversToStop.push(id);
          else serversSkipped.push(id);
        }
      }

      const lock = await acquireDepotLock(app.redis, {
        onRenewError: (error) => app.log.error({ err: error }, 'failed to renew depot update lock'),
      });
      if (!lock) {
        const holder = await app.redis.get(DEPOT_LOCK_KEY);
        return {
          status: 'already_in_progress',
          since: holder ? depotLockStartedAt(holder) : new Date().toISOString(),
        };
      }

      // The depot is one volume mounted into every Squad container (#20
      // follow-up, same hazard as server-update.ts): a container server not
      // listed in server_ids keeps its live process mounted on the volume
      // while phase 2 below rewrites it. Refuse unless every other live
      // container server is explicitly included in server_ids.
      const requestedIds = new Set(serverIds);
      const liveServers = await app.db
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            eq(servers.runtime, 'container'),
            isNull(servers.deletedAt),
            inArray(servers.status, LIVE_STATUSES),
          ),
        );
      const unlistedLive = liveServers.filter((row) => !requestedIds.has(row.id));
      if (unlistedLive.length > 0) {
        await lock.release();
        reply.code(409);
        return { error: 'servers_running', server_ids: unlistedLive.map((r) => r.id) };
      }

      // Background orchestration: stop servers → update depot → restart servers.
      (async () => {
        const dedicated = app.makeBridgeClient();
        const stoppedIds: string[] = [];

        /**
         * Logs a per-server failure and mirrors it onto depot:progress as a
         * stderr line (#143), so the operator watching the update sees which
         * server was left running or down. Publishing is best-effort.
         */
        async function reportServerFailure(sid: string, action: string, error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          app.log.error({ err: error, server_id: sid }, `depot update: ${action} failed`);
          await publishDepotProgressLine(
            app.redis,
            'stderr',
            `Failed to ${action} server squad-${sid}: ${message}`,
          ).catch((publishError: unknown) => {
            app.log.error(
              { err: publishError, server_id: sid },
              'failed to publish depot failure line',
            );
          });
        }

        /**
         * Restart each stopped server by recreating its container from the
         * current server_settings. A server is marked `starting` only once one of them
         * actually launched it; otherwise it stays `stopped` and the failure
         * is reported (#143).
         */
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
              const settings = await app.db.query.serverSettings.findFirst({
                where: eq(serverSettings.serverId, sid),
              });
              if (!settings) throw new Error('server settings not found');
              const existing = await app.bridge
                .containerInspect({ name: `squad-${sid}` })
                .catch(() => null);
              // Recreated from the current settings: a plain `containerStart`
              // would keep the ports and slots the container was created with (#320).
              await runFreshServerContainer(app.bridge, sid, settings, existing !== null);
              await app.db
                .update(servers)
                .set({ status: 'starting', updatedAt: new Date() })
                .where(eq(servers.id, sid));
            } catch (error) {
              // One failed restart must not abort the loop for the others.
              await reportServerFailure(sid, 'restart', error);
            }
          }
        }

        let finalStatus: 'done' | 'error' = 'done';
        let finalError: string | undefined;
        try {
          await dedicated.connect();

          // ── Phase 1: stop the requested servers that are running ──
          for (const sid of serversToStop) {
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
            } catch (error) {
              // Continue with the remaining servers; this one keeps running
              // through the update, which the operator must see.
              await reportServerFailure(sid, 'stop', error);
            }
          }

          // ── Phase 2: run SteamCMD depot update ──
          // Each progress line is awaited (not fired-and-forgotten): a silently
          // dropped xadd would leave depot:last_update=ok even though a
          // progress frame never made it to the stream.
          const steamCmdStreamWrites: Promise<void>[] = [];
          const steamCmdStreamWriteErrors: unknown[] = [];
          const { exit_code: exitCode } = await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            steamCmdStreamWrites.push(
              publishDepotProgressLine(app.redis, frame.stream, text).catch((error: unknown) => {
                steamCmdStreamWriteErrors.push(error);
              }),
            );
          });
          await Promise.all(steamCmdStreamWrites);
          if (steamCmdStreamWriteErrors.length > 0) throw steamCmdStreamWriteErrors[0];
          // The bridge reports a failed SteamCMD run as a normal reply.
          if (exitCode !== 0) throw new Error(`steamcmd failed with exit code ${exitCode}`);

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
          await lock.release().catch((error: unknown) => {
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
        started_at: lock.startedAt,
        servers_to_stop: serversToStop,
        servers_skipped: serversSkipped,
      };
    },
  );

  app.get(
    '/api/v1/depot/progress/ws',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket, req) => {
      const release = progressStreams.acquire(streamCallerKey(req));
      if (!release) {
        socket.send(JSON.stringify({ error: 'too_many_streams' }));
        socket.close(WS_CLOSE_TRY_AGAIN_LATER, 'too_many_streams');
        return;
      }
      let closed = false;
      let lastId = '0';
      // A blocking XREAD occupies the connection it runs on until data
      // arrives or the block times out — issuing it on the shared app.redis
      // singleton would queue every other route's Redis command behind it
      // for up to 5s at a time. Each connection gets its own duplicate,
      // matching the pattern in plugins/live-bus.ts.
      // XREAD BLOCK 5000 outlives the shared client's command timeout, so
      // this connection waits for replies without one.
      const redis = app.redis.duplicate({ commandTimeout: undefined });
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
          sendUnlessStalled(socket, text);
          return true;
        }
        // A watcher that stops reading is dropped rather than buffering the
        // SteamCMD output in the API process (#1297).
        sendUnlessStalled(
          socket,
          JSON.stringify({ ts: new Date().toISOString(), stream, message: text }),
        );
        return false;
      }

      void (async () => {
        try {
          // Backfill may span a prior, already-finished run followed by the
          // run the client just triggered — a 'done' seen here isn't
          // necessarily current, so it's forwarded (for context) but never
          // treated as terminal. Only 'done' frames seen live, after
          // `backfill_complete`, end the connection.
          // Newest 500 entries (XREVRANGE, restored to chronological order) so
          // a long history never resumes the live tail from an old run.
          const newestFirst = (await redis.xrevrange(
            DEPOT_PROGRESS_STREAM,
            '+',
            '-',
            'COUNT',
            '500',
          )) as Array<[string, string[]]>;
          const backfill = newestFirst.reverse();
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
          const updating = await redis.get(DEPOT_LOCK_KEY);
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
        release();
        // Forcibly tears down an in-flight blocking XREAD so a client that
        // disconnects mid-block doesn't leave the duplicate connection open
        // for up to another 5s waiting on data nobody will read.
        redis.disconnect();
      });
    },
  );
};

export default depotRoutes;
