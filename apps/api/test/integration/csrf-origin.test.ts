import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

// The harness serves PANEL_PUBLIC_URL=https://panel.test.
const PANEL_ORIGIN = 'https://panel.test';

let h: IntegrationHarness;
let cookie: string;

/** A cookie-authenticated mutating request that succeeds with 201 when allowed. */
async function createIssue(headers: Record<string, string>) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/issues',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ title: 'CSRF probe', body: 'probe' }),
  });
}

describeIfDb('cross-site request guard (#66)', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: testSteamId(940) } });
    cookie = await loginAsOwner(h);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('rejects a cookie-authenticated POST from a sibling-subdomain origin', async () => {
    const res = await createIssue({ origin: 'https://forum.panel.test' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'cross_site_request_forbidden' });
  });

  it('rejects an opaque null origin', async () => {
    expect((await createIssue({ origin: 'null' })).statusCode).toBe(403);
  });

  it('rejects a same-site (not same-origin) fetch that omits Origin', async () => {
    expect((await createIssue({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
  });

  it('allows the panel origin and a request whose Origin matches its Host', async () => {
    expect((await createIssue({ origin: PANEL_ORIGIN })).statusCode).toBe(201);
    expect(
      (await createIssue({ origin: 'http://localhost:8080', host: 'localhost:8080' })).statusCode,
    ).toBe(201);
    expect((await createIssue({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
  });

  it('allows a non-browser client that sends neither Origin nor Sec-Fetch-Site', async () => {
    expect((await createIssue({})).statusCode).toBe(201);
  });

  it('does not apply to requests without the session cookie', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x', body: 'y' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a cross-site WebSocket handshake carrying the session cookie', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ws/live',
      headers: {
        cookie,
        origin: 'https://evil.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a real cross-site WebSocket upgrade but accepts the panel origin', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;

    /** Resolves with the handshake outcome: 'open' or the HTTP status that refused it. */
    const handshake = (origin: string) =>
      new Promise<string | number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`, {
          headers: { cookie, origin },
        });
        ws.once('open', () => {
          ws.close();
          resolve('open');
        });
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('error', () => undefined);
      });

    expect(await handshake('https://evil.example')).toBe(403);
    expect(await handshake(PANEL_ORIGIN)).toBe('open');
  });
});
