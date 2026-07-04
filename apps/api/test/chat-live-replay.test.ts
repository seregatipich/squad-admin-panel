import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';

let app: ReturnType<typeof Fastify>;
let port: number;

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function chat(id: string, message: string): LiveEvent {
  return {
    type: 'chat.message',
    ts: '2026-04-23T11:30:20.485Z',
    data: {
      id,
      server_id: SERVER_ID,
      ts: '2026-04-23T11:30:20.485Z',
      channel: 'ChatAll',
      player_id: null,
      player_name: 'Alpha',
      steam_id64: '76561198012345678',
      eos_id: null,
      message,
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
  await app.register(liveRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

async function connect(): Promise<{ ws: WebSocket; received: LiveEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
  const received: LiveEvent[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as LiveEvent;
    if (frame.type === 'chat.message') received.push(frame);
  });
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, received };
}

async function close(ws: WebSocket): Promise<void> {
  ws.close();
  await new Promise<void>((resolve) => ws.on('close', () => resolve()));
}

describe('/api/v1/ws/live chat replay buffer', () => {
  it('forwards live chat.message events to a connected socket', async () => {
    const { ws, received } = await connect();
    app.liveBus.publish(chat('live-1', 'hello live'));
    await waitFor(() => received.some((e) => e.data.id === 'live-1'));
    expect(received.find((e) => e.data.id === 'live-1')?.data.message).toBe('hello live');
    await close(ws);
  });

  it('replays the buffered tail to a socket that connects after messages were sent', async () => {
    app.liveBus.publish(chat('buf-1', 'first'));
    app.liveBus.publish(chat('buf-2', 'second'));

    const { ws, received } = await connect();
    await waitFor(() => received.some((e) => e.data.id === 'buf-2'));
    const ids = received.map((e) => e.data.id);
    expect(ids).toContain('buf-1');
    expect(ids).toContain('buf-2');
    await close(ws);
  });

  it('a reconnecting client still receives the tail it would otherwise miss', async () => {
    app.liveBus.publish(chat('recon-1', 'before disconnect'));
    const first = await connect();
    await waitFor(() => first.received.some((e) => e.data.id === 'recon-1'));
    await close(first.ws);

    const second = await connect();
    await waitFor(() => second.received.some((e) => e.data.id === 'recon-1'));
    expect(second.received.map((e) => e.data.id)).toContain('recon-1');
    await close(second.ws);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
