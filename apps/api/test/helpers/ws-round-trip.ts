import type WebSocket from 'ws';

/**
 * Resolves once the server has answered a ping on `ws`.
 *
 * The server handles a socket's traffic in order, and the tests run it in the
 * same process, so every frame it queued for this socket before the ping
 * (live events, a refusal, a close) has arrived by the time the pong does. Use
 * it to prove that a frame was filtered out instead of sleeping and hoping.
 */
export async function wsRoundTrip(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once('pong', () => resolve());
    ws.ping();
  });
}
