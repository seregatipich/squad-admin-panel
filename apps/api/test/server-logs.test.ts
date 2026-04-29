/**
 * /api/v1/servers/:id/logs/ws — Squad-server journal live-tail.
 *
 * Uses a fake bridge client that calls the onStream callback with synthetic
 * journal frames so we can assert the WebSocket fan-out shape without a real
 * systemd/journald.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import serverLogsRoutes from '../src/routes/server-logs.js';

const testId = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

let app: ReturnType<typeof Fastify>;
let port: number;

// Shared handle to the fake bridge so the test can drive "frames" after
// the WebSocket connects.
let pushFrame: (data: string, stream?: 'stdout' | 'stderr') => void;
let resolveFollow: () => void;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {
    query: {
      servers: {
        findFirst: async () => ({ id: testId, displayName: 'Fake', status: 'running' }),
      },
    },
  });
  // diag plugin needs `xadd`; provide a no-op so emits are silent.
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', { xadd: async () => '0-0' });
  const fakeBridge = {
    connect: async () => undefined,
    close: async () => undefined,
    containerLogsFollow: (
      _params: unknown,
      onStream: (frame: { stream: string; data: string }) => void,
    ) => {
      pushFrame = (data, stream = 'stdout') => {
        onStream({ stream, data });
      };
      return new Promise<{ exit_code: number }>((resolve) => {
        resolveFollow = () => resolve({ exit_code: 0 });
      });
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', fakeBridge);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('makeBridgeClient', () => fakeBridge);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('encryptionKey', Buffer.alloc(32));
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(diagPlugin);
  await app.register(serverLogsRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

describe('/api/v1/servers/:id/logs/ws', () => {
  it('fans out journal lines and splits multi-line frames', async () => {
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/${testId}/logs/ws?lines=0`);
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    // give the route a tick to register the onStream callback
    await waitFor(() => typeof pushFrame === 'function');

    pushFrame('single line');
    pushFrame('line A\nline B\nline C');
    pushFrame('stderr row', 'stderr');

    await waitFor(() => received.length >= 5);
    resolveFollow();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));

    const messages = received.map((r) => (r as { message?: string }).message ?? '');
    expect(messages.slice(0, 5)).toEqual([
      'single line',
      'line A',
      'line B',
      'line C',
      'stderr row',
    ]);
    const last = received.at(-1) as { done?: boolean };
    expect(last.done).toBe(true);
    const errRow = received.find((r) => (r as { message?: string }).message === 'stderr row');
    expect(errRow?.stream).toBe('stderr');
  });

  it('rejects an invalid server id', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/not-a-uuid/logs/ws`);
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(frames[0]).toEqual({ error: 'invalid_id' });
  });

  it('refuses to follow when the server has no systemd unit yet (status=pending)', async () => {
    // swap the DB stub to return a pending server
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (app as any).db.query.servers.findFirst = async () => ({
      id: testId,
      displayName: 'Never installed',
      status: 'pending',
    });
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/${testId}/logs/ws`);
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(
      frames.some(
        (f) =>
          typeof (f as { message?: string }).message === 'string' &&
          (f as { message: string }).message.includes('pending'),
      ),
    ).toBe(true);
    const last = frames.at(-1) as { done?: boolean };
    expect(last.done).toBe(true);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
