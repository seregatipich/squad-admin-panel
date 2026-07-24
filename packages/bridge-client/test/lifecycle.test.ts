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

describe('squad log file RPCs (LOG-2)', () => {
  it('squadLogList sends squad_log_list and returns the file listing', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
          params: unknown;
        };
        expect(req.method).toBe('squad_log_list');
        expect(req.params).toEqual({ path: '/saved/x/SquadGame/Saved/Logs' });
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: {
            files: [
              { name: 'SquadGame.log', size: 10, mtime: '2026-07-24T00:00:00Z', is_live: true },
            ],
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const res = await client.squadLogList({ path: '/saved/x/SquadGame/Saved/Logs' });
      expect(res.files).toHaveLength(1);
      expect(res.files[0]?.is_live).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('fileReadStream delivers chunk frames via onStream and resolves with bytes_sent', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
        };
        expect(req.method).toBe('file_read_stream');
        sendFrame(conn, {
          id: req.id,
          stream: 'stdout',
          data: Buffer.from('AAAA').toString('base64'),
        });
        sendFrame(conn, {
          id: req.id,
          stream: 'stdout',
          data: Buffer.from('BBBB').toString('base64'),
        });
        sendFrame(conn, { id: req.id, ok: true, result: { bytes_sent: 8 } });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const frames: string[] = [];
      const res = await client.fileReadStream(
        { path: '/saved/x/SquadGame/Saved/Logs/SquadGame.log', chunk_size: 4 },
        (f) => frames.push(f.data as string),
      );
      expect(res.bytes_sent).toBe(8);
      expect(frames).toHaveLength(2);
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

describe('squad_log_retention_sweep', () => {
  it('squadLogRetentionSweep sends the archive-enabled server set and returns sweep counters', async () => {
    let receivedMethod: string | undefined;
    let receivedParams: unknown = 'not-captured';
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
            retention_days: 10,
            cutoff: '2026-06-27T12:00:00Z',
            servers_scanned: 2,
            log_dirs_scanned: 2,
            files_scanned: 8,
            deleted_count: 3,
            deleted_bytes: 4096,
            archived_count: 1,
            archived_bytes: 512,
            error_count: 0,
            errors: [],
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const flagged = ['019dbaa5-1234-7abc-8def-0123456789ab'];
    try {
      const result = await client.squadLogRetentionSweep({ archive_server_ids: flagged });
      expect(receivedMethod).toBe('squad_log_retention_sweep');
      expect(receivedParams).toEqual({ archive_server_ids: flagged });
      expect(result.retention_days).toBe(10);
      expect(result.deleted_count).toBe(3);
      expect(result.deleted_bytes).toBe(4096);
      expect(result.archived_count).toBe(1);
      expect(result.archived_bytes).toBe(512);
      expect(result.error_count).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('squadLogRetentionSweep defaults to an empty archive set when called with no args', async () => {
    let receivedParams: unknown = 'not-captured';
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
            retention_days: 10,
            cutoff: '2026-06-27T12:00:00Z',
            servers_scanned: 0,
            log_dirs_scanned: 0,
            files_scanned: 0,
            deleted_count: 0,
            deleted_bytes: 0,
            archived_count: 0,
            archived_bytes: 0,
            error_count: 0,
            errors: [],
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      await client.squadLogRetentionSweep();
      expect(receivedParams).toEqual({ archive_server_ids: [] });
    } finally {
      await client.close();
    }
  });
});

describe('file_read_tail', () => {
  it('fileReadTail sends method=file_read_tail and round-trips the response shape', async () => {
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
            content: 'line2\nline3\n',
            offset: 6,
            size: 18,
            truncated: true,
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const result = await client.fileReadTail({
        path: '/var/lib/squad-panel/saved/019dbaa5-1234-7abc-8def-0123456789ab/SquadGame/Saved/Logs/SquadGame.log',
        max_bytes: 12,
      });
      expect(receivedMethod).toBe('file_read_tail');
      expect(receivedParams).toEqual({
        path: '/var/lib/squad-panel/saved/019dbaa5-1234-7abc-8def-0123456789ab/SquadGame/Saved/Logs/SquadGame.log',
        max_bytes: 12,
      });
      expect(result.content).toBe('line2\nline3\n');
      expect(result.offset).toBe(6);
      expect(result.size).toBe(18);
      expect(result.truncated).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('event emission', () => {
  it('emits connected with rttMs+version+hostname on the first ping response', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1.2.3', hostname: 'event-host' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const connectedEvents: Array<{ rttMs: number; version: string; hostname: string }> = [];
    client.on('connected', (info) => connectedEvents.push(info));

    try {
      await client.ping();
      expect(connectedEvents).toHaveLength(1);
      expect(connectedEvents[0]?.version).toBe('v1.2.3');
      expect(connectedEvents[0]?.hostname).toBe('event-host');
      expect(typeof connectedEvents[0]?.rttMs).toBe('number');
      expect(connectedEvents[0]?.rttMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it('does not emit connected twice for back-to-back pings on the same socket', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1.0.0', hostname: 'h' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const connectedEvents: unknown[] = [];
    client.on('connected', (info) => connectedEvents.push(info));

    try {
      await client.ping();
      await client.ping();
      await client.ping();
      expect(connectedEvents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('emits rtt for every successful RPC', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const rttSamples: number[] = [];
    client.on('rtt', (ms) => rttSamples.push(ms));

    try {
      await client.ping();
      await client.ping();
      expect(rttSamples).toHaveLength(2);
      for (const sample of rttSamples) {
        expect(typeof sample).toBe('number');
        expect(sample).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await client.close();
    }
  });

  it('emits rpc-error with method/code/message on a non-ok response', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
        };
        sendFrame(conn, {
          id: req.id,
          ok: false,
          error: { code: 'forbidden', message: 'path not allowlisted' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const rpcErrors: Array<{ method: string; code: string; message: string }> = [];
    client.on('rpc-error', (info) => rpcErrors.push(info));

    try {
      await expect(client.fileRead({ path: '/etc/passwd' })).rejects.toThrow();
      expect(rpcErrors).toHaveLength(1);
      expect(rpcErrors[0]?.method).toBe('file_read');
      expect(rpcErrors[0]?.code).toBe('forbidden');
      expect(rpcErrors[0]?.message).toBe('path not allowlisted');
    } finally {
      await client.close();
    }
  });

  it('emits disconnected with client-closed when close() is called on a connected client', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (reason) => reasons.push(reason));

    await client.ping();
    await client.close();
    expect(reasons).toContain('client-closed');
  });

  it('emits disconnected with frame-decode-error when the socket sends an oversized frame header', async () => {
    let callCount = 0;
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        callCount++;
        if (callCount === 1) {
          const size = chunk.readUInt32BE(0);
          const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as { id: string };
          sendFrame(conn, {
            id: req.id,
            ok: true,
            result: { pong: true, version: 'v1', hostname: 'h' },
          });
          return;
        }
        const oversizedHeader = Buffer.alloc(4);
        oversizedHeader.writeUInt32BE(BRIDGE_MAX_FRAME_BYTES + 1, 0);
        conn.write(oversizedHeader);
      });
    });

    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (reason) => reasons.push(reason));

    try {
      await client.ping();
      await expect(client.ping()).rejects.toThrow();
      expect(reasons).toContain('frame-decode-error');
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

describe('backup RPCs (INFRA-8-P1)', () => {
  it('backupSnapshots sends backup_snapshots and returns the snapshot listing', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
        };
        expect(req.method).toBe('backup_snapshots');
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: {
            snapshots: [
              {
                id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
                short_id: 'a1b2c3d4',
                time: '2026-07-24T03:00:00Z',
                hostname: 'tk104',
                paths: ['/data'],
                tags: [],
              },
            ],
          },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const res = await client.backupSnapshots();
      expect(res.snapshots).toHaveLength(1);
      expect(res.snapshots[0]?.short_id).toBe('a1b2c3d4');
    } finally {
      await client.close();
    }
  });

  it('backupRun streams progress frames and resolves with exit_code', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
        };
        expect(req.method).toBe('backup_run');
        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'Files:  10 new\n' });
        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'snapshot a1b2c3d4 saved\n' });
        sendFrame(conn, { id: req.id, ok: true, result: { exit_code: 0 } });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const frames: string[] = [];
      const res = await client.backupRun((f) => frames.push(f.data as string));
      expect(res.exit_code).toBe(0);
      expect(frames).toEqual(['Files:  10 new\n', 'snapshot a1b2c3d4 saved\n']);
    } finally {
      await client.close();
    }
  });

  it('backupRestore sends the snapshot id, streams, and resolves with exit_code', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const req = JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8')) as {
          id: string;
          method: string;
          params: { snapshot_id: string };
        };
        expect(req.method).toBe('backup_restore');
        expect(req.params).toEqual({ snapshot_id: 'a1b2c3d4' });
        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'Restore complete.\n' });
        sendFrame(conn, { id: req.id, ok: true, result: { exit_code: 0 } });
      });
    });

    const client = new BridgeClient({ socketPath });
    try {
      const frames: string[] = [];
      const res = await client.backupRestore({ snapshot_id: 'a1b2c3d4' }, (f) =>
        frames.push(f.data as string),
      );
      expect(res.exit_code).toBe(0);
      expect(frames).toEqual(['Restore complete.\n']);
    } finally {
      await client.close();
    }
  });
});
