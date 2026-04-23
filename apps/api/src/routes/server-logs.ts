import { servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Live Squad-server journal stream. Opens `journalctl_follow` on the bridge
 * for the server's systemd unit and forwards each line as a JSON frame to
 * the WebSocket client.
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

      const unit = `squad-server-${id}.service`;
      let closed = false;
      // Dedicated bridge connection so closing the WebSocket tears down
      // the journalctl subprocess on the other side cleanly — otherwise
      // the Go process lingers until it tries to write into a closed
      // socket.
      const dedicatedBridge = app.makeBridgeClient();

      (async () => {
        const row = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
        if (!row) {
          safeSend({ error: 'not_found' });
          socket.close();
          return;
        }

        // journalctl_follow on a systemd unit that was never installed is a
        // blackhole: it waits forever for messages that will never come and
        // ties up a bridge RPC slot. Refuse upfront so the browser doesn't
        // open a useless socket that only closes on timeout.
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
            message: `[panel] сервер в состоянии "${row.status}" — журнал systemd ещё не создан. Запустите установку.`,
          });
          safeSend({ done: true });
          socket.close();
          return;
        }

        try {
          await dedicatedBridge.connect();
          await dedicatedBridge.journalctlFollow({ unit, lines: backfillLines }, (frame) => {
            if (closed) return;
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            // A single bridge frame may carry several newline-delimited journal
            // lines; split so the UI renders one row per line.
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
        // Close the dedicated bridge connection so the bridge's
        // journalctl subprocess receives EOF and exits.
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
