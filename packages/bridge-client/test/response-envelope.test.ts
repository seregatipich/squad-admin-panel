import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../src/client.js';
import { BridgeError } from '../src/errors.js';
import { encodeFrame } from '../src/frame.js';

let server: Server;
let socketPath: string;
let openConns: Socket[];

beforeEach(() => {
  socketPath = join(tmpdir(), `bridge-envelope-${Date.now()}-${Math.random()}.sock`);
  try {
    unlinkSync(socketPath);
  } catch {}
  openConns = [];
  server = createServer((c) => openConns.push(c));
  server.listen(socketPath);
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      vi.restoreAllMocks();
      for (const c of openConns) c.destroy();
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

/** Answers every request with the frames produced by `reply`, in order. */
function respondWith(reply: (id: string) => unknown[]) {
  server.on('connection', (conn) => {
    conn.on('data', (chunk) => {
      const req = readReq(chunk);
      for (const frame of reply(req.id)) conn.write(encodeFrame(frame));
    });
  });
}

describe('response envelope validation', () => {
  it('rejects the pending call with code=internal when the envelope has the wrong shape', async () => {
    respondWith((id) => [{ id, ok: 'yes', result: {} }]);
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 5_000 });
    const err = await client.hostInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe('internal');
    expect((err as BridgeError).message).toContain('malformed bridge response');
    await client.close();
  });

  it('drops JSON null, a bare string, id-less frames and frames for unknown calls without breaking the stream', async () => {
    respondWith((id) => [
      null,
      'just a string',
      { id: 42, ok: true, result: {} },
      { ok: true, result: {} },
      { id: 'no-such-call', ok: 'yes' },
      { id, ok: true, result: { pong: true, version: 'v1', hostname: 'h' } },
    ]);
    const onLog = vi.fn();
    const client = new BridgeClient({ socketPath, onLog, defaultTimeoutMs: 5_000 });
    const result = await client.ping();
    expect(result.hostname).toBe('h');
    const malformedLogs = onLog.mock.calls.filter((c) =>
      String(c[0]).includes('malformed bridge frame'),
    );
    expect(malformedLogs).toHaveLength(5);
    expect(String(malformedLogs[1]?.[1]?.err)).toContain('<root>');
    await client.close();
  });

  it('fails a call without a timeout on a malformed response too', async () => {
    respondWith((id) => [{ id, ok: true, error: 'not-an-object' }]);
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: Number.POSITIVE_INFINITY });
    const err = await client.hostInfo().catch((e: unknown) => e);
    expect((err as BridgeError).code).toBe('internal');
    expect((err as BridgeError).message).toContain('error:');
    await client.close();
  });

  it('maps an unknown error code to internal while keeping the bridge message', async () => {
    respondWith((id) => [
      { id, ok: false, error: { code: 'brand_new_code', message: 'disk on fire' } },
    ]);
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 5_000 });
    const err = await client.hostInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe('internal');
    expect((err as BridgeError).message).toBe('disk on fire');
    await client.close();
  });

  it('delivers stream frames through the validated envelope', async () => {
    respondWith((id) => [
      { id, stream: 'bogus', data: 'dropped' },
      { id, stream: 'stdout', data: 'line' },
      { id, ok: true, result: { exit_code: 0 } },
    ]);
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 5_000 });
    const lines: unknown[] = [];
    const result = await client.depotUpdate((f) => lines.push(f.data));
    expect(result.exit_code).toBe(0);
    expect(lines).toEqual(['line']);
    await client.close();
  });
});

describe('large frame reassembly', () => {
  it('copies each received byte a bounded number of times, not once per chunk', async () => {
    const blob = 'x'.repeat(4 * 1024 * 1024);
    const encoded = encodeFrame({ id: 'placeholder', ok: true, result: { blob } });
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        const frame = encodeFrame({ id: req.id, ok: true, result: { blob } });
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
          conn.write(frame.subarray(offset, offset + chunkSize));
        }
      });
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 10_000 });
    await client.connect();
    const realConcat = Buffer.concat;
    let copiedBytes = 0;
    vi.spyOn(Buffer, 'concat').mockImplementation((list, totalLength) => {
      const out = realConcat(list, totalLength);
      copiedBytes += out.byteLength;
      return out;
    });
    const result = (await client.hostInfo()) as unknown as { blob: string };
    expect(result.blob).toHaveLength(blob.length);
    expect(copiedBytes).toBeLessThan(encoded.byteLength * 3);
    await client.close();
  });
});
