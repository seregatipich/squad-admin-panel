import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

/**
 * Opens a real WS upgrade against the integration app's real TCP listener
 * with no session cookie attached. `ws`'s `'unexpected-response'` event
 * (emitted by `ws@8.21.1`'s `lib/websocket.js` whenever the server answers a
 * non-101 status and at least one listener is attached) lets this resolve
 * the exact rejection status instead of only observing a generic `'error'`.
 */
async function connectUnauthenticated(
  path: string,
): Promise<{ opened: true } | { opened: false; statusCode: number }> {
  if (!h.app.server.listening) {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('integration app has no TCP port');

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.close();
      resolve({ opened: true });
    });
    socket.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ opened: false, statusCode: res.statusCode ?? 0 });
    });
    socket.once('error', reject);
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({ bridge: makeFakeBridge() });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
}, 90_000);

afterAll(async () => {
  await h?.cleanup();
});

describeIfDb('WS auth boundary (#250)', () => {
  it('rejects an unauthenticated upgrade to GET /api/v1/ws/live with 401 before a connection is established', async () => {
    const result = await connectUnauthenticated('/api/v1/ws/live');
    expect(result.opened).toBe(false);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });

  it('rejects an unauthenticated upgrade to GET /api/v1/servers/:id/logs/ws with 401 before a connection is established', async () => {
    const result = await connectUnauthenticated(
      '/api/v1/servers/00000000-0000-0000-0000-000000000001/logs/ws',
    );
    expect(result.opened).toBe(false);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });

  it('rejects an unauthenticated upgrade to GET /api/v1/servers/:id/install/ws with 401 before a connection is established', async () => {
    const result = await connectUnauthenticated(
      '/api/v1/servers/00000000-0000-0000-0000-000000000001/install/ws',
    );
    expect(result.opened).toBe(false);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });

  it('rejects an unauthenticated upgrade to GET /api/v1/depot/progress/ws with 401 before a connection is established', async () => {
    const result = await connectUnauthenticated('/api/v1/depot/progress/ws');
    expect(result.opened).toBe(false);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });
});
