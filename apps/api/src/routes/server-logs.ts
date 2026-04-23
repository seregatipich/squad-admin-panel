import { servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

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
 * Query params:
 *   ?lines=<N>  — initial backfill (default 200, max 5000)
 */
const serverLogsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/servers/:id/logs/ws',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket, req) => {
      const params = (req.params ?? {}) as { id?: string };
      const id = params.id;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
        socket.send(JSON.stringify({ error: 'invalid_id' }));
        socket.close();
        return;
      }
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

      (async () => {
        const row = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
        if (!row) {
          safeSend({ error: 'not_found' });
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
        } catch (err) {
          if (!closed) safeSend({ error: (err as Error).message });
        } finally {
          if (!closed) socket.close();
          await dedicatedBridge.close().catch(() => undefined);
        }
      })();

      socket.on('close', () => {
        closed = true;
        dedicatedBridge.close().catch(() => undefined);
      });

      function safeSend(payload: unknown) {
        if (closed) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          closed = true;
        }
      }
    },
  );
};

export default serverLogsRoutes;
