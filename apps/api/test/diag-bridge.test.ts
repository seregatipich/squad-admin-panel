import { unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeClient } from '@squad/bridge-client';
import type { Diag, DiagEvent } from '@squad/diag';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import diagPlugin from '../src/lib/diag.js';
import bridgePlugin from '../src/plugins/bridge.js';

function makeFakeRedis() {
  return {
    async xadd(..._args: unknown[]) {
      return '0-0';
    },
  };
}

let server: Server;
let socketPath: string;

beforeEach(() => {
  socketPath = join(tmpdir(), `diag-bridge-test-${Date.now()}-${Math.random()}.sock`);
  try {
    unlinkSync(socketPath);
  } catch {}
  server = createServer();
  server.listen(socketPath);
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        try {
          unlinkSync(socketPath);
        } catch {}
        resolve();
      });
    }),
);

async function buildApp(): Promise<{ app: FastifyInstance; captured: DiagEvent[] }> {
  const app = Fastify({ logger: false });
  (app as unknown as { redis: unknown }).redis = makeFakeRedis();
  await app.register(diagPlugin);

  const captured: DiagEvent[] = [];
  (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
    captured.push(ev);
  };

  await app.register(bridgePlugin, {
    config: {
      BRIDGE_SOCKET: socketPath,
    } as Parameters<typeof bridgePlugin>[1]['config'],
  });

  return { app, captured };
}

async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

describe('bridge plugin → diag listeners', () => {
  it('emits bridge.client.connected when BridgeClient fires connected', async () => {
    const { app, captured } = await buildApp();
    try {
      const bridge = (app as unknown as { bridge: BridgeClient }).bridge;
      bridge.emit('connected', { rttMs: 12, version: 'v1.2.3', hostname: 'h-test' });
      await flushMicrotasks();

      const ev = captured.find((e) => e.kind === 'bridge.client.connected');
      expect(ev).toBeDefined();
      expect(ev?.component).toBe('api');
      expect(ev?.severity).toBe('info');
      expect(ev?.payload).toEqual({ rttMs: 12, version: 'v1.2.3', hostname: 'h-test' });
      expect(ev?.message).toContain('rtt=12ms');
      expect(ev?.message).toContain('v1.2.3');
    } finally {
      await app.close();
    }
  });

  it('emits bridge.client.disconnected with the reason string', async () => {
    const { app, captured } = await buildApp();
    try {
      const bridge = (app as unknown as { bridge: BridgeClient }).bridge;
      bridge.emit('disconnected', 'socket-closed');
      await flushMicrotasks();

      const ev = captured.find((e) => e.kind === 'bridge.client.disconnected');
      expect(ev).toBeDefined();
      expect(ev?.component).toBe('api');
      expect(ev?.severity).toBe('error');
      expect(ev?.payload).toEqual({ reason: 'socket-closed' });
      expect(ev?.message).toContain('socket-closed');
    } finally {
      await app.close();
    }
  });

  it('emits bridge.rpc.error on non-ok responses', async () => {
    const { app, captured } = await buildApp();
    try {
      const bridge = (app as unknown as { bridge: BridgeClient }).bridge;
      bridge.emit('rpc-error', {
        method: 'file_read',
        code: 'forbidden',
        message: 'path not allowlisted',
      });
      await flushMicrotasks();

      const ev = captured.find((e) => e.kind === 'bridge.rpc.error');
      expect(ev).toBeDefined();
      expect(ev?.component).toBe('api');
      expect(ev?.severity).toBe('warn');
      expect(ev?.payload).toEqual({
        method: 'file_read',
        code: 'forbidden',
        message: 'path not allowlisted',
      });
    } finally {
      await app.close();
    }
  });

  it('emits bridge.rtt.outlier only when RTT exceeds 50ms', async () => {
    const { app, captured } = await buildApp();
    try {
      const bridge = (app as unknown as { bridge: BridgeClient }).bridge;
      bridge.emit('rtt', 12);
      bridge.emit('rtt', 50);
      bridge.emit('rtt', 75);
      await flushMicrotasks();

      const outliers = captured.filter((e) => e.kind === 'bridge.rtt.outlier');
      expect(outliers).toHaveLength(1);
      expect(outliers[0]?.severity).toBe('warn');
      expect(outliers[0]?.payload).toEqual({ rttMs: 75, thresholdMs: 50 });
    } finally {
      await app.close();
    }
  });

  it('listener-side diag.emit failures do not propagate', async () => {
    const app = Fastify({ logger: false });
    (app as unknown as { redis: unknown }).redis = makeFakeRedis();
    await app.register(diagPlugin);
    (app as unknown as { diag: Diag }).diag.emit = async () => {
      throw new Error('redis offline');
    };
    await app.register(bridgePlugin, {
      config: {
        BRIDGE_SOCKET: socketPath,
      } as Parameters<typeof bridgePlugin>[1]['config'],
    });

    try {
      const bridge = (app as unknown as { bridge: BridgeClient }).bridge;
      expect(() => {
        bridge.emit('connected', { rttMs: 5, version: 'v1', hostname: 'h' });
        bridge.emit('rpc-error', { method: 'ping', code: 'internal', message: 'boom' });
        bridge.emit('disconnected', 'socket-error');
        bridge.emit('rtt', 999);
      }).not.toThrow();
      await flushMicrotasks();
    } finally {
      await app.close();
    }
  });
});
