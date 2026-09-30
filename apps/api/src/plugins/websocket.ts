import websocket from '@fastify/websocket';
import fp from 'fastify-plugin';

/**
 * Largest client frame any panel WebSocket accepts. The only client→server
 * frame in the protocol is the live-bus `{"type":"pong"}` reply, so 4 KiB is
 * generous; `ws` closes the socket with 1009 on anything larger instead of
 * buffering its 100 MiB default.
 */
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 4096;

export interface WebSocketPluginOptions {
  /** The panel's public URL (`PANEL_PUBLIC_URL`); only its origin is used. */
  allowedOrigin: string;
}

/**
 * Whether a WebSocket upgrade's `Origin` header may open a socket.
 *
 * Browsers always send `Origin` on a WebSocket handshake, so a present header
 * must equal the panel's own origin — this stops cross-site WebSocket
 * hijacking from sibling (same-site) hosts that `SameSite=Lax` cookies do not
 * cover. Non-browser clients (API tokens) send none and stay allowed; they
 * still pass the normal auth hook.
 *
 * @param origin - The request's `Origin` header, if any.
 * @param allowedOrigin - `PANEL_PUBLIC_URL` or any URL on the panel's origin.
 * @returns `true` when the upgrade may proceed.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  allowedOrigin: string,
): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Registers `@fastify/websocket` with a bounded frame size and rejects
 * cross-origin upgrades (403 `forbidden_origin`) before any route or auth
 * hook runs. Every WebSocket route on the instance inherits both limits.
 */
export default fp<WebSocketPluginOptions>(
  async (app, opts) => {
    await app.register(websocket, { options: { maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES } });
    app.addHook('onRequest', async (req, reply) => {
      if (!req.ws) return;
      if (isAllowedWebSocketOrigin(req.headers.origin, opts.allowedOrigin)) return;
      reply.code(403);
      return reply.send({ error: 'forbidden_origin' });
    });
  },
  { name: 'panel-websocket' },
);
