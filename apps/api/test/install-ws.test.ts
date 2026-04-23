/**
 * TZ §17.6 — WebSocket progress stream must replay the buffered snapshot
 * on connect, stream new lines as they are published, and close on the
 * terminal {done:true} frame after the `done` step.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import installProgressPlugin from '../src/plugins/install-progress.js';
import serverInstallRoutes from '../src/routes/server-install.js';

let app: ReturnType<typeof Fastify>;
let port: number;
const testId = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('encryptionKey', Buffer.alloc(32));
  // No auth plugin registered; routes' config.permissions is consulted by
  // the auth plugin we omitted, so this test exercises the WebSocket
  // handshake directly. The CI guard separately verifies that route
  // config declares permissions.
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(installProgressPlugin);
  await app.register(serverInstallRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

describe('server install WebSocket progress stream', () => {
  it('replays buffered lines on connect and streams new ones until {done:true}', async () => {
    app.installProgress.publish(testId, {
      ts: '2026-04-23T00:00:00.000Z',
      step: 'prereqs',
      message: 'buffered-1',
    });
    app.installProgress.publish(testId, {
      ts: '2026-04-23T00:00:01.000Z',
      step: 'steamcmd',
      message: 'buffered-2',
    });

    const received: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/${testId}/install/ws`);
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    // Give the server a tick to flush the snapshot frames.
    await new Promise((r) => setTimeout(r, 50));
    app.installProgress.publish(testId, {
      ts: '2026-04-23T00:00:02.000Z',
      step: 'systemd-unit',
      message: 'live-3',
    });
    app.installProgress.publish(testId, {
      ts: '2026-04-23T00:00:03.000Z',
      step: 'done',
      message: 'install complete',
    });

    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    const steps = received
      .map((r) => (r as { step?: string; done?: boolean }).step ?? (r as { done?: boolean }).done)
      .filter(Boolean);
    expect(steps).toContain('prereqs');
    expect(steps).toContain('steamcmd');
    expect(steps).toContain('systemd-unit');
    expect(steps).toContain('done');
    // final frame is {done:true}
    const last = received[received.length - 1] as { done?: boolean; final?: string };
    expect(last.done).toBe(true);
    expect(last.final).toBe('done');
  });

  it('rejects malformed id with invalid_id and closes', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/not-a-uuid/install/ws`);
    const frames: unknown[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(frames[0]).toEqual({ error: 'invalid_id' });
  });
});
