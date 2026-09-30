import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';

/**
 * #69 (finding #1305): high-volume and consumer-less event types (chat,
 * combat, roster snapshots, ban-match notifications) reach a socket only after
 * it subscribes to them, and the chat/combat tails are replayed on subscribe
 * rather than to every connection on connect.
 */
let app: ReturnType<typeof Fastify>;
let port: number;

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282aaaa';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282bbbb';

function chat(id: string, serverId = SERVER_A): LiveEvent {
  return {
    type: 'chat.message',
    ts: '2026-09-28T10:00:00.000Z',
    data: {
      id,
      server_id: serverId,
      ts: '2026-09-28T10:00:00.000Z',
      channel: 'ChatAll',
      player_id: null,
      player_name: 'Alpha',
      steam_id64: '76561198012345678',
      eos_id: null,
      message: `message ${id}`,
    },
  };
}

function heartbeat(worker: string): LiveEvent {
  return {
    type: 'worker.heartbeat',
    ts: new Date().toISOString(),
    data: { worker, healthy: true },
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

interface Frame {
  type: string;
  data?: Record<string, unknown>;
  events?: string[];
}

async function connect(): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
  const frames: Frame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, frames };
}

async function send(
  sock: { ws: WebSocket; frames: Frame[] },
  type: 'subscribe' | 'unsubscribe',
  events: string[],
): Promise<void> {
  const ack = type === 'subscribe' ? 'subscribed' : 'unsubscribed';
  const before = sock.frames.filter((f) => f.type === ack).length;
  sock.ws.send(JSON.stringify({ type, events }));
  await waitFor(() => sock.frames.filter((f) => f.type === ack).length > before);
}

/** Publishes a broadcast marker and waits for it, so every earlier frame has been delivered. */
async function flush(sock: { frames: Frame[] }, marker: string): Promise<void> {
  app.liveBus.publish(heartbeat(marker));
  await waitFor(() =>
    sock.frames.some((f) => f.type === 'worker.heartbeat' && f.data?.worker === marker),
  );
}

async function close(ws: WebSocket): Promise<void> {
  ws.close();
  await new Promise<void>((resolve) => ws.on('close', () => resolve()));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const chatIds = (frames: Frame[]) =>
  frames.filter((f) => f.type === 'chat.message').map((f) => f.data?.id);

describe('/api/v1/ws/live per-socket event subscriptions', () => {
  it('does not push opt-in event types or replay tails to a socket that has not subscribed', async () => {
    app.liveBus.publish(chat('before-connect'));
    const sock = await connect();

    app.liveBus.publish(chat('live-unsubscribed'));
    app.liveBus.publish({
      type: 'rcon.roster',
      ts: new Date().toISOString(),
      data: { server_id: SERVER_A, players: [] },
    } as unknown as LiveEvent);
    // Worker-published types the API union does not model are opt-in too.
    app.liveBus.publish({
      type: 'banname.matched',
      ts: new Date().toISOString(),
      data: {},
    } as unknown as LiveEvent);
    await flush(sock, 'unsubscribed-marker');

    const types = sock.frames.map((f) => f.type);
    expect(types).not.toContain('chat.message');
    expect(types).not.toContain('rcon.roster');
    expect(types).not.toContain('banname.matched');
    await close(sock.ws);
  });

  it('replays the chat tail on subscribe, then forwards live chat until unsubscribed', async () => {
    app.liveBus.publish(chat('tail-1'));
    const sock = await connect();
    await send(sock, 'subscribe', ['chat.message']);
    await waitFor(() => chatIds(sock.frames).includes('tail-1'));

    app.liveBus.publish(chat('live-1'));
    await waitFor(() => chatIds(sock.frames).includes('live-1'));

    await send(sock, 'unsubscribe', ['chat.message']);
    app.liveBus.publish(chat('after-unsubscribe'));
    await flush(sock, 'after-unsubscribe-marker');
    expect(chatIds(sock.frames)).not.toContain('after-unsubscribe');
    await close(sock.ws);
  });

  it('delivers subscribed worker-published types the API union does not model', async () => {
    const sock = await connect();
    await send(sock, 'subscribe', ['banname.matched']);
    app.liveBus.publish({
      type: 'banname.matched',
      ts: new Date().toISOString(),
      data: { rule_id: 'r1' },
    } as unknown as LiveEvent);
    await waitFor(() => sock.frames.some((f) => f.type === 'banname.matched'));
    await close(sock.ws);
  });

  it('forgets a deleted server’s buffered tail', async () => {
    app.liveBus.publish(chat('gone-1', SERVER_B));
    app.liveBus.publish({
      type: 'server.deleted',
      ts: new Date().toISOString(),
      data: { server_id: SERVER_B, deleted_at: new Date().toISOString(), by: null },
    });
    const sock = await connect();
    await send(sock, 'subscribe', ['chat.message']);
    await flush(sock, 'deleted-server-marker');
    expect(chatIds(sock.frames)).not.toContain('gone-1');
    await close(sock.ws);
  });

  it('ignores malformed subscription frames without closing the socket', async () => {
    const sock = await connect();
    sock.ws.send(JSON.stringify({ type: 'subscribe', events: 'chat.message' }));
    sock.ws.send(JSON.stringify({ type: 'subscribe', events: [42, 'x'.repeat(500)] }));
    sock.ws.send('not json');
    await flush(sock, 'malformed-marker');
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
    app.liveBus.publish(chat('still-opt-in'));
    await flush(sock, 'malformed-marker-2');
    expect(chatIds(sock.frames)).not.toContain('still-opt-in');
    await close(sock.ws);
  });
});
