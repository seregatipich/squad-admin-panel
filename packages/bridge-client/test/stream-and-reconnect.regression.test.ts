import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../src/client.js';
import { encodeFrame } from '../src/frame.js';

let server: Server;
let socketPath: string;
let conns: Socket[];

beforeEach(() => {
  socketPath = join(tmpdir(), `bridge-reconnect-${Date.now()}-${Math.random()}.sock`);
  try {
    unlinkSync(socketPath);
  } catch {}
  conns = [];
  server = createServer((c) => conns.push(c));
  server.listen(socketPath);
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      for (const c of conns) c.destroy();
      server.close(() => {
        try {
          unlinkSync(socketPath);
        } catch {}
        resolve();
      });
    }),
);

function readReq(chunk: Buffer): { id: string; method: string } {
  const size = chunk.readUInt32BE(0);
  return JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8'));
}

const pong = (id: string) =>
  encodeFrame({ id, ok: true, result: { pong: true, version: 'v', hostname: 'h' } });

describe('#1047 throwing onStream callback', () => {
  it('is contained: the call fails, later frames still work', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const { id, method } = readReq(chunk);
        if (method === 'ping') return void conn.write(pong(id));
        conn.write(encodeFrame({ id, stream: 'stdout', data: 'aGk=' }));
      });
    });
    const onLog = vi.fn();
    const client = new BridgeClient({ socketPath, onLog, defaultTimeoutMs: 1_000 });
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const err = await client
        .fileReadStream({ path: '/x' } as never, () => {
          throw new Error('boom');
        })
        .catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('internal');
      expect((await client.ping()).hostname).toBe('h');
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
      await client.close();
    }
  });
});

describe('#1048 reconnect', () => {
  it('drops a partial frame of the old socket and does not reject calls of the new socket', async () => {
    let first = true;
    server.on('connection', (conn) => {
      const isFirst = first;
      first = false;
      conn.on('data', (chunk) => {
        const { id } = readReq(chunk);
        if (isFirst) {
          // Header promising 10000 bytes, then hang up mid-frame.
          const partial = Buffer.alloc(8);
          partial.writeUInt32BE(10_000, 0);
          conn.write(partial);
          setTimeout(() => conn.destroy(), 20);
          return;
        }
        conn.write(pong(id));
      });
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 1_000 });
    // ping retries once on transport failure; the retry runs on a fresh socket.
    const result = await client.ping();
    expect(result.hostname).toBe('h');
    await client.close();
  });

  it('a late close of a replaced socket leaves the new socket calls pending', async () => {
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 2_000 });
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const { id } = readReq(chunk);
        if (conns.length === 2) setTimeout(() => conn.write(pong(id)), 50);
      });
    });
    await client.connect();
    const oldSock = conns[0] as Socket;
    const oldClientSocket = (client as unknown as { socket: Socket }).socket;
    (client as unknown as { socket: Socket | undefined }).socket = undefined;
    const call = client.ping();
    await vi.waitFor(() =>
      expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1),
    );
    oldClientSocket.destroy();
    oldSock.destroy();
    expect((await call).hostname).toBe('h');
    await client.close();
  });
});
