import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_MAX_FRAME_BYTES } from '@squad/shared-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/client.js';
import { encodeFrame } from '../src/frame.js';
import { BridgeError } from '../src/types.js';

let server: Server;
let socketPath: string;

beforeEach(() => {
  socketPath = join(tmpdir(), `bridge-test-${Date.now()}-${Math.random()}.sock`);
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

function sendFrame(sock: Socket, payload: object) {
  sock.write(encodeFrame(payload));
}

function sendRawBytes(sock: Socket, buf: Buffer) {
  sock.write(buf);
}

describe('connect → request → response', () => {
  it('sends ping and receives pong', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
        };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: '1.0', hostname: 'test-host' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.ping();
      expect(result.pong).toBe(true);
      expect(result.hostname).toBe('test-host');
    } finally {
      await client.close();
    }
  });
});

describe('length-prefix framing', () => {
  it('reassembles a frame split across two data events', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        const frame = encodeFrame({
          id: req.id,
          ok: true,
          result: { pong: true, version: '1.0', hostname: 'split-host' },
        });
        conn.write(frame.subarray(0, 3));
        setImmediate(() => conn.write(frame.subarray(3)));
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.ping();
      expect(result.hostname).toBe('split-host');
    } finally {
      await client.close();
    }
  });
});

describe('decode error recovery', () => {
  it('does not permanently close client when server sends corrupt bytes', async () => {
    let callCount = 0;

    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        callCount++;
        if (callCount === 1) {
          sendRawBytes(conn, Buffer.from([0x00, 0x00, 0x00, 0x05, 0xff, 0xfe, 0xfd, 0xfc, 0xfb]));
          conn.end();
          return;
        }
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: '1.0', hostname: 'recovered' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      await expect(client.ping()).rejects.toThrow();

      const result = await client.ping();
      expect(result.pong).toBe(true);
      expect(result.hostname).toBe('recovered');
    } finally {
      await client.close();
    }
  });
});

describe('oversized frame rejection', () => {
  it('rejects a frame header claiming more than 16 MiB', async () => {
    server.on('connection', (conn) => {
      conn.once('data', () => {
        const oversizedHeader = Buffer.alloc(4);
        oversizedHeader.writeUInt32BE(BRIDGE_MAX_FRAME_BYTES + 1, 0);
        conn.write(oversizedHeader);
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      await expect(client.ping()).rejects.toThrow(BridgeError);
    } finally {
      await client.close();
    }
  });
});

describe('streaming method', () => {
  it('delivers log frames via onStream callback and resolves on done', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };

        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'line one\n' });
        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'line two\n' });
        sendFrame(conn, { id: req.id, ok: true, result: { exit_code: 0 } });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const received: string[] = [];
      const result = await client.containerLogsFollow({ name: 'squad-test', tail: 10 }, (frame) => {
        received.push(frame.data as string);
      });
      expect(result.exit_code).toBe(0);
      expect(received).toEqual(['line one\n', 'line two\n']);
    } finally {
      await client.close();
    }
  });
});

describe('panel_disk_usage', () => {
  it('panelDiskUsage sends method=panel_disk_usage and round-trips the response shape', async () => {
    let receivedMethod: string | undefined;
    let receivedParams: unknown;
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
          params?: unknown;
        };
        receivedMethod = req.method;
        receivedParams = req.params;
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: {
            configs_bytes: 100,
            saved_total_bytes: 200,
            saved_per_server: [{ uuid: 's1', bytes: 50 }],
            depot_volume_bytes: 1000,
            docker_volumes: [],
            docker_images: [],
            audit_archive_bytes: 0,
            total_panel_bytes: 1300,
            host_total_bytes: 1_000_000,
            host_used_bytes: 500_000,
            computed_at: '2026-04-28T10:00:00Z',
            cache_age_seconds: 0,
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.panelDiskUsage();
      expect(receivedMethod).toBe('panel_disk_usage');
      expect(receivedParams).toEqual({});
      expect(result.total_panel_bytes).toBe(1300);
      expect(result.saved_per_server).toHaveLength(1);
      expect(result.saved_per_server[0]).toEqual({ uuid: 's1', bytes: 50 });
      expect(result.host_used_bytes).toBe(500_000);
      expect(result.computed_at).toBe('2026-04-28T10:00:00Z');
    } finally {
      await client.close();
    }
  });

  it('passes { force: true } when called with force=true', async () => {
    let receivedParams: unknown;
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
          params?: unknown;
        };
        receivedParams = req.params;
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: {
            configs_bytes: 0,
            saved_total_bytes: 0,
            saved_per_server: [],
            depot_volume_bytes: 0,
            docker_volumes: [],
            docker_images: [],
            audit_archive_bytes: 0,
            total_panel_bytes: 0,
            host_total_bytes: 0,
            host_used_bytes: 0,
            computed_at: '2026-04-28T10:00:00Z',
            cache_age_seconds: 0,
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      await client.panelDiskUsage({ force: true });
      expect(receivedParams).toEqual({ force: true });
    } finally {
      await client.close();
    }
  });
});

describe('independent client teardown', () => {
  it('closing one client does not affect a second independent client', async () => {
    const respondPing = (conn: Socket) => {
      conn.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: '1.0', hostname: 'alive' },
        });
      });
    };

    server.on('connection', respondPing);

    const clientA = new BridgeClient({ socketPath });
    const clientB = new BridgeClient({ socketPath });

    try {
      await clientA.ping();
      await clientA.close();

      const result = await clientB.ping();
      expect(result.pong).toBe(true);
    } finally {
      await clientB.close();
    }
  });
});
