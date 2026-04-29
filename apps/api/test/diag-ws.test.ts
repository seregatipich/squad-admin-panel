/**
 * Phase A2 Task 14 — diag emits on WS lifecycle.
 *
 * Each WS route (`/api/v1/ws/live`, `/api/v1/servers/:id/install/ws`,
 * `/api/v1/servers/:id/logs/ws`) must emit a `ws.connected` (info),
 * `ws.disconnected` (info, payload `{code, reason, url[, serverId]}`)
 * and `ws.error` (warn) on the underlying `WebSocket` events. The
 * `serverId` field is propagated from URL params on per-server routes.
 *
 * `ws.error` is not exercised here: simulating a real socket error
 * after the upgrade handshake from the client side inside vitest is
 * flaky (the server-side `error` event needs a low-level transport
 * fault). The handler is wired identically to `ws.connected` and
 * `ws.disconnected`, so the contract is covered by code review +
 * integration use.
 */
import type { Diag, DiagEvent } from '@squad/diag';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import installProgressPlugin from '../src/plugins/install-progress.js';
import liveBusPlugin from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';
import serverInstallRoutes from '../src/routes/server-install.js';
import serverLogsRoutes from '../src/routes/server-logs.js';

const testId = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

let app: ReturnType<typeof Fastify>;
let port: number;
let captured: DiagEvent[];

function makeFakeRedis() {
  return {
    async xadd(..._args: unknown[]) {
      return '0-0';
    },
  };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', makeFakeRedis());
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {
    query: {
      servers: {
        findFirst: async () => ({ id: testId, displayName: 'Fake', status: 'running' }),
      },
    },
  });
  const fakeBridge = {
    connect: async () => undefined,
    close: async () => undefined,
    containerLogsFollow: (
      _params: unknown,
      _onStream: (frame: { stream: string; data: string }) => void,
    ) =>
      new Promise<{ exit_code: number }>((resolve) => {
        // The follow promise resolves only when the test releases it via
        // socket close → dedicatedBridge.close(). For now hold it open so
        // the diag-disconnected emit fires on the close event.
        setTimeout(() => resolve({ exit_code: 0 }), 60_000).unref();
      }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', fakeBridge);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('makeBridgeClient', () => ({ ...fakeBridge }));
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('encryptionKey', Buffer.alloc(32));

  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(diagPlugin);
  captured = [];
  (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
    captured.push(ev);
  };
  await app.register(liveBusPlugin);
  await app.register(installProgressPlugin);
  await app.register(liveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverLogsRoutes);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Phase A2 Task 14 — WS lifecycle diag emits', () => {
  it('emits ws.connected and ws.disconnected for /api/v1/ws/live', async () => {
    captured.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    await waitFor(() => captured.some((e) => e.kind === 'ws.connected'));
    const connected = captured.find((e) => e.kind === 'ws.connected');
    expect(connected).toBeDefined();
    expect(connected?.component).toBe('api');
    expect(connected?.severity).toBe('info');
    expect((connected?.payload as { url?: string }).url).toContain('/api/v1/ws/live');
    expect(connected?.serverId).toBeUndefined();

    ws.close(1000, 'bye');
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await waitFor(() => captured.some((e) => e.kind === 'ws.disconnected'));
    const disconnected = captured.find((e) => e.kind === 'ws.disconnected');
    expect(disconnected).toBeDefined();
    expect(disconnected?.severity).toBe('info');
    const payload = disconnected?.payload as { code?: number; reason?: string; url?: string };
    expect(typeof payload.code).toBe('number');
    expect(payload.url).toContain('/api/v1/ws/live');
    expect(payload.reason ?? '').toContain('bye');
  });

  it('emits ws.connected with serverId for /api/v1/servers/:id/install/ws', async () => {
    captured.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/${testId}/install/ws`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    await waitFor(() => captured.some((e) => e.kind === 'ws.connected'));
    const connected = captured.find((e) => e.kind === 'ws.connected');
    expect(connected?.serverId).toBe(testId);
    expect((connected?.payload as { serverId?: string }).serverId).toBe(testId);

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await waitFor(() => captured.some((e) => e.kind === 'ws.disconnected'));
    const disconnected = captured.find((e) => e.kind === 'ws.disconnected');
    expect(disconnected?.serverId).toBe(testId);
  });

  it('emits ws.connected with serverId for /api/v1/servers/:id/logs/ws', async () => {
    captured.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/${testId}/logs/ws?lines=0`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitFor(() => captured.some((e) => e.kind === 'ws.connected'));
    const connected = captured.find((e) => e.kind === 'ws.connected');
    expect(connected?.serverId).toBe(testId);
    expect((connected?.payload as { url?: string }).url).toContain('/logs/ws');

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await waitFor(() => captured.some((e) => e.kind === 'ws.disconnected'));
    const disconnected = captured.find((e) => e.kind === 'ws.disconnected');
    expect(disconnected?.serverId).toBe(testId);
  });

  it('does not emit ws.connected for an invalid-id WebSocket', async () => {
    captured.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/INVALID/logs/ws`);
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.some((e) => e.kind === 'ws.connected')).toBe(false);
    expect(captured.some((e) => e.kind === 'ws.disconnected')).toBe(false);

    captured.length = 0;
    const wsInstall = new WebSocket(`ws://127.0.0.1:${port}/api/v1/servers/INVALID/install/ws`);
    await new Promise<void>((resolve) => wsInstall.on('close', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.some((e) => e.kind === 'ws.connected')).toBe(false);
    expect(captured.some((e) => e.kind === 'ws.disconnected')).toBe(false);
  });
});
