import type { FastifyPluginAsync } from 'fastify';
import { ChatRingBuffer } from '../lib/chat-ring-buffer.js';
import { CombatRingBuffer } from '../lib/combat-ring-buffer.js';

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
const CHAT_BUFFER_PER_SERVER = 100;
const COMBAT_BUFFER_PER_SERVER = 100;

const liveRoutes: FastifyPluginAsync = async (app) => {
  const chatBuffer = new ChatRingBuffer(CHAT_BUFFER_PER_SERVER);
  const stopChatBuffer = app.liveBus.subscribe((event) => chatBuffer.push(event));
  app.addHook('onClose', async () => stopChatBuffer());

  const combatBuffer = new CombatRingBuffer(COMBAT_BUFFER_PER_SERVER);
  const stopCombatBuffer = app.liveBus.subscribe((event) => combatBuffer.push(event));
  app.addHook('onClose', async () => stopCombatBuffer());

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
      const canViewCombat = req.user?.permissions.combatView ?? false;

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
        if (event.type === 'combat.event' && !canViewCombat) return;
        safeSend(event);
      });

      for (const buffered of chatBuffer.tail()) safeSend(buffered);
      if (canViewCombat) {
        for (const buffered of combatBuffer.tail()) safeSend(buffered);
      }

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
