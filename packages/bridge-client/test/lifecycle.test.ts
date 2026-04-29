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
  it('transparently recovers from corrupt bytes via the transport-retry path', async () => {
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
      const result = await client.ping();
      expect(result.pong).toBe(true);
      expect(result.hostname).toBe('recovered');
      expect(callCount).toBe(2);
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

describe('transport retry on socket close', () => {
  it('idempotent rpc auto-retries when the bridge drops the socket mid-call', async () => {
    let connectionCount = 0;

    server.on('connection', (conn) => {
      connectionCount++;
      if (connectionCount === 1) {
        conn.once('data', () => {
          conn.destroy();
        });
        return;
      }
      conn.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: '1.0', hostname: 'retried' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.ping();
      expect(result.hostname).toBe('retried');
      expect(connectionCount).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('fileRead retries on socket close (covers the config-sync drift path)', async () => {
    let connectionCount = 0;

    server.on('connection', (conn) => {
      connectionCount++;
      if (connectionCount === 1) {
        conn.once('data', () => {
          conn.destroy();
        });
        return;
      }
      conn.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { content: 'admins-cfg-body' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.fileRead({ path: '/var/lib/squad-panel/configs/x/y.cfg' });
      expect(result.content).toBe('admins-cfg-body');
      expect(connectionCount).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('non-idempotent rpc (host_agent_restart) does NOT auto-retry', async () => {
    let connectionCount = 0;

    server.on('connection', (conn) => {
      connectionCount++;
      conn.once('data', () => {
        conn.destroy();
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      await expect(client.hostAgentRestart()).rejects.toThrow(BridgeError);
      await new Promise((r) => setTimeout(r, 100));
      expect(connectionCount).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('propagates the transport error if the retry also fails', async () => {
    server.on('connection', (conn) => {
      conn.once('data', () => {
        conn.destroy();
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
