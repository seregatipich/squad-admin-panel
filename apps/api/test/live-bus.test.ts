import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';

let app: ReturnType<typeof Fastify>;
let port: number;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Minimal redis stub: live-bus skips duplicate()/publish when missing.
  // diag plugin needs `xadd`; provide a no-op so emits are silent.
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

describe('/api/v1/ws/live', () => {
  it('forwards published LiveEvents to connected sockets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    const received: LiveEvent[] = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as LiveEvent;
      received.push(frame);
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const event: LiveEvent = {
      type: 'server.status',
      ts: '2026-04-26T00:00:00.000Z',
      data: {
        server_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee2c',
        status: 'running',
        source: 'reconciler',
      },
    };
    app.liveBus.publish(event);

    await waitFor(() => received.some((e) => e.type === 'server.status'));
    const got = received.find((e) => e.type === 'server.status');
    expect(got).toEqual(event);

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
  });

  it('treats client pong frames as liveness signals (no disconnect)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    let closeCode: number | undefined;
    ws.on('close', (code) => {
      closeCode = code;
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    ws.send(JSON.stringify({ type: 'pong' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(closeCode).toBeUndefined();

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
  });

  it('unsubscribes on socket close so handler counts do not leak', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));

    let delivered = 0;
    const offProbe = app.liveBus.subscribe(() => {
      delivered += 1;
    });
    app.liveBus.publish({
      type: 'bridge.connection',
      ts: new Date().toISOString(),
      data: { state: 'up', down_for_s: 0 },
    });
    offProbe();
    expect(delivered).toBe(1);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
