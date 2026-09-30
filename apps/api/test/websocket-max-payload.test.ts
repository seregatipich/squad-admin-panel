import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

// Regression test for finding #1302: @fastify/websocket was registered with
// no options, so ws's default 100 MiB maxPayload applied to every websocket
// route (live, logs, install, depot). An authenticated caller could send an
// unnecessarily huge frame that gets buffered and JSON.parse'd even though
// the real client-side frames are tiny control messages.

async function buildApp(maxPayload?: number) {
  const app = Fastify({ logger: false });
  await app.register(websocket, maxPayload !== undefined ? { options: { maxPayload } } : {});
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', () => {
      socket.send('ack');
    });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || !address) throw new Error('no server address');
  return { app, url: `ws://127.0.0.1:${address.port}/ws` };
}

let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('websocket maxPayload', () => {
  it('closes the connection when a frame exceeds the configured 4096-byte cap', async () => {
    const built = await buildApp(4096);
    app = built.app;
    const client = new WebSocket(built.url);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const closed = new Promise<number>((resolve) => {
      client.once('close', (code) => resolve(code));
    });
    client.send('x'.repeat(5000));

    const code = await closed;
    // ws closes oversized-frame connections with 1009 (message too big).
    expect(code).toBe(1009);
  });

  it('accepts a frame under the cap', async () => {
    const built = await buildApp(4096);
    app = built.app;
    const client = new WebSocket(built.url);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const reply = new Promise<string>((resolve) => {
      client.once('message', (data) => resolve(data.toString()));
    });
    client.send('small frame');

    await expect(reply).resolves.toBe('ack');
    client.close();
  });
});
