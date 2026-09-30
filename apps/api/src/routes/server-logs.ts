import { servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { isExternalRuntime } from '../lib/server-runtime.js';
import { sendUnlessStalled } from '../lib/ws-send.js';
import {
  createStreamLimiter,
  streamCallerKey,
  WS_CLOSE_TRY_AGAIN_LATER,
} from '../lib/ws-stream-limit.js';

/** Live log sockets one caller may hold open at once (#1298). */
export const LOG_STREAMS_PER_CALLER = 4;
/** Live log sockets this API process holds open at once (#1298). */
const LOG_STREAMS_TOTAL = 32;

/**
 * Live Squad-server log stream. Attaches to the server's Docker container
 * via `container_logs_follow` on the bridge and forwards each line as a
 * JSON frame to the WebSocket client.
 *
 * Protocol (server → client):
 *   {"ts": ISO, "stream": "stdout"|"stderr", "message": string}
 *   {"error": string}          — terminal
 *   {"done": true}             — follow ended cleanly
 *
 *   {"error": "too_many_streams"} — terminal, close code 1013 (#1298)
 *
 * Query params:
 *   ?lines=<N>  — initial backfill (default 200, max 5000)
 *
 * The container's stdout is the same content as `SquadGame.log`, including
 * player IPs (`AddClientConnection … RemoteAddr`), so the stream needs
 * `server:download_logs` like the log-file routes, not just `server:view`
 * (#1239). Every socket costs a root `docker logs --follow` process on the
 * bridge, so sockets are capped per caller and per process (#1298).
 */
const serverLogsRoutes: FastifyPluginAsync = async (app) => {
  const logStreams = createStreamLimiter({
    perCaller: LOG_STREAMS_PER_CALLER,
    total: LOG_STREAMS_TOTAL,
  });

  app.get(
    '/api/v1/servers/:id/logs/ws',
    {
      websocket: true,
      config: { permissions: ['server:download_logs'], audit: false },
    },
    (socket, req) => {
      const params = (req.params ?? {}) as { id?: string };
      const id = params.id;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
        socket.send(JSON.stringify({ error: 'invalid_id' }));
        socket.close();
        return;
      }
      const release = logStreams.acquire(streamCallerKey(req));
      if (!release) {
        socket.send(JSON.stringify({ error: 'too_many_streams' }));
        socket.close(WS_CLOSE_TRY_AGAIN_LATER, 'too_many_streams');
        return;
      }

      app.diag
        .emit({
          component: 'api',
          kind: 'ws.connected',
          severity: 'info',
          serverId: id,
          message: `ws ${req.url} connected`,
          payload: { url: req.url, serverId: id },
        })
        .catch(() => undefined);

      socket.on('error', (err) => {
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.error',
            severity: 'warn',
            serverId: id,
            message: `ws error: ${err.message}`,
            payload: { errorMessage: err.message, url: req.url },
          })
          .catch(() => undefined);
      });
      const query = (req.query ?? {}) as { lines?: string };
      const requested = Number(query.lines ?? '200');
      const backfillLines = Number.isFinite(requested)
        ? Math.max(0, Math.min(5000, Math.trunc(requested)))
        : 200;

      const name = `squad-${id}`;
      let closed = false;
      // Dedicated bridge connection so closing the WebSocket tears down
      // the `docker logs -f` subprocess on the bridge side cleanly.
      const dedicatedBridge = app.makeBridgeClient();
      // Frame-level heartbeat: keeps proxies (caddy, nginx) from killing the
      // socket on idle when the container is quiet. Cleared on socket close.
      const heartbeatInterval = setInterval(() => {
        if (closed) return;
        safeSend({ heartbeat: true });
      }, 20_000);

      (async () => {
        try {
          const row = await app.db.query.servers.findFirst({
            where: and(eq(servers.id, id), isNull(servers.deletedAt)),
          });
          if (!row) {
            safeSend({ error: 'not_found' });
            socket.close();
            return;
          }

          // #296: an external server (runtime='external') is marked
          // 'running' at creation and has no panel-managed container, so the
          // `installed` check below would pass and this would ask the bridge
          // to follow logs for a container that was never created.
          if (isExternalRuntime(row.runtime)) {
            safeSend({ error: 'external_server' });
            socket.close();
            return;
          }

          // Refuse upfront if the container was never created; otherwise
          // `docker logs` errors are spammy and the user sees nothing useful.
          const installed =
            row.status === 'running' ||
            row.status === 'starting' ||
            row.status === 'stopping' ||
            row.status === 'stopped' ||
            row.status === 'ready';
          if (!installed) {
            safeSend({
              ts: new Date().toISOString(),
              stream: 'stdout',
              message: `[panel] сервер в состоянии "${row.status}" — контейнер ещё не создан. Запустите установку.`,
            });
            safeSend({ done: true });
            socket.close();
            return;
          }

          try {
            await dedicatedBridge.connect();
            await dedicatedBridge.containerLogsFollow({ name, tail: backfillLines }, (frame) => {
              if (closed) return;
              const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
              for (const line of text.split(/\r?\n/)) {
                if (line.length === 0) continue;
                safeSend({
                  ts: new Date().toISOString(),
                  stream: frame.stream === 'stderr' ? 'stderr' : 'stdout',
                  message: line,
                });
              }
            });
            safeSend({ done: true });
            if (!closed) socket.close();
          } finally {
            await dedicatedBridge.close().catch(() => undefined);
          }
        } catch (err) {
          // #295: `findFirst` used to run before this try block, so a DB
          // failure rejected this IIFE with nothing awaiting it — the client
          // got no {error} and the socket stayed open on heartbeats alone.
          if (!closed) {
            safeSend({ error: (err as Error).message });
            socket.close();
          }
          await dedicatedBridge.close().catch(() => undefined);
        }
      })().catch((err) => {
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.error',
            severity: 'error',
            serverId: id,
            message: `unhandled error in logs ws handler: ${(err as Error).message}`,
            payload: { errorMessage: (err as Error).message, url: req.url },
          })
          .catch(() => undefined);
      });

      socket.on('close', (code, reason) => {
        closed = true;
        release();
        clearInterval(heartbeatInterval);
        dedicatedBridge.close().catch(() => undefined);
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.disconnected',
            severity: 'info',
            serverId: id,
            message: `ws ${req.url} closed code=${code}`,
            payload: {
              code,
              reason: reason?.toString().slice(0, 200) ?? '',
              url: req.url,
              serverId: id,
            },
          })
          .catch(() => undefined);
      });

      // A viewer that stops reading is dropped rather than buffering the
      // container's log stream in the API process (#1297).
      function safeSend(payload: unknown) {
        if (closed) return;
        try {
          if (!sendUnlessStalled(socket, JSON.stringify(payload))) closed = true;
        } catch {
          closed = true;
        }
      }
    },
  );
};

export default serverLogsRoutes;
