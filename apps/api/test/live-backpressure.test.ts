import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';

// #1297: a client that stops reading must not make the API buffer the live
// stream for it without bound.
const MAX_BUFFERED_BYTES = 64 * 1024;
const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2d';

let app: ReturnType<typeof Fastify>;
let port: number;

function chat(id: number, messageBytes: number): LiveEvent {
  return {
    type: 'chat.message',
    ts: '2026-04-23T11:30:20.485Z',
    data: {
      id: `bp-${id}`,
      server_id: SERVER_ID,
      ts: '2026-04-23T11:30:20.485Z',
      channel: 'ChatAll',
      player_id: null,
      player_name: 'Flooder',
      steam_id64: '76561198012345678',
      eos_id: null,
      message: 'x'.repeat(messageBytes),
    },
  };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', { xadd: async () => '0-0' });
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(diagPlugin);
  await app.register(liveBusPlugin);
  await app.register(liveRoutes, { maxBufferedBytes: MAX_BUFFERED_BYTES });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

// The normal-reader case runs first: the chat replay buffer a new socket
// receives on connect is still small then.
describe('/api/v1/ws/live backpressure', () => {
  it('keeps delivering to a client that reads normally', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    const received: string[] = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as LiveEvent;
      if (frame.type === 'chat.message') received.push(frame.data.id);
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    received.length = 0;

    for (let index = 0; index < 20; index++) {
      app.liveBus.publish(chat(10_000 + index, 1024));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect.poll(() => received.filter((id) => id.startsWith('bp-100')).length).toBe(20);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('drops a client that stops reading once its send buffer exceeds the limit', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

    // Stop reading: the server's kernel buffers fill and further frames
    // queue in the API process.
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    for (let index = 0; index < 1_000; index++) {
      app.liveBus.publish(chat(index, 32 * 1024));
      await new Promise((resolve) => setImmediate(resolve));
    }

    (ws as unknown as { _socket: { resume(): void } })._socket.resume();
    const code = await closed;
    expect(code).toBe(1006);
  }, 20_000);
});
