import type { FastifyPluginAsync } from 'fastify';

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;

const liveRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/ws/live',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket, req) => {
      let lastPongAt = Date.now();
      let closed = false;
      const connectionPlayerId = req.user?.playerId ?? null;

      app.diag
        .emit({
          component: 'api',
          kind: 'ws.connected',
          severity: 'info',
          message: `ws ${req.url} connected`,
          payload: { url: req.url },
        })
        .catch(() => undefined);

      const safeSend = (payload: unknown): void => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'live-bus: send failed');
        }
      };

      const pinger = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
          closed = true;
          try {
            socket.close(4000, 'pong timeout');
          } catch {
            /* noop */
          }
          return;
        }
        safeSend({ type: 'ping', ts: new Date().toISOString() });
      }, PING_INTERVAL_MS);

      const unsubscribe = app.liveBus.subscribe((event) => {
        if (event.type === 'session.revoked' && event.data.player_id !== connectionPlayerId) {
          return;
        }
        safeSend(event);
      });

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === 'pong') lastPongAt = Date.now();
        } catch {
          /* ignore malformed client frames */
        }
      });

      socket.on('close', (code, reason) => {
        closed = true;
        clearInterval(pinger);
        unsubscribe();
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.disconnected',
            severity: 'info',
            message: `ws ${req.url} closed code=${code}`,
            payload: {
              code,
              reason: reason?.toString().slice(0, 200) ?? '',
              url: req.url,
            },
          })
          .catch(() => undefined);
      });

      socket.on('error', (err) => {
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.error',
            severity: 'warn',
            message: `ws error: ${err.message}`,
            payload: { errorMessage: err.message, url: req.url },
          })
          .catch(() => undefined);
      });
    },
  );
};

export default liveRoutes;
