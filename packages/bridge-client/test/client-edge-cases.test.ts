import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../src/client.js';
import { encodeFrame } from '../src/frame.js';
import { BridgeError } from '../src/types.js';

let server: Server;
let socketPath: string;
let openConns: Socket[];

beforeEach(() => {
  socketPath = join(tmpdir(), `bridge-edge-${Date.now()}-${Math.random()}.sock`);
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
      for (const c of openConns) c.destroy();
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

function readReq(chunk: Buffer): { id: string; method: string; params?: unknown } {
  const size = chunk.readUInt32BE(0);
  return JSON.parse(chunk.subarray(4, 4 + size).toString('utf-8'));
}

describe('constructor defaults', () => {
  it('falls back to BRIDGE_SOCKET_DEFAULT and 15s timeout when no opts are given', () => {
    const client = new BridgeClient();
    const internal = client as unknown as { socketPath: string; defaultTimeoutMs: number };
    expect(internal.socketPath).toBe('/run/panel-host-bridge/bridge.sock');
    expect(internal.defaultTimeoutMs).toBe(15_000);
  });
});

describe('connection failure', () => {
  it('rejects connect() when the socket path does not exist', async () => {
    const client = new BridgeClient({ socketPath: '/run/does-not-exist.sock' });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  });

  it('coalesces parallel connect() calls into a single dial', async () => {
    let connectionCount = 0;
    server.on('connection', (conn) => {
      connectionCount++;
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });

    const client = new BridgeClient({ socketPath });
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    expect(connectionCount).toBe(1);
    await client.ping();
    await client.close();
  });

  it('connect() is a no-op when already connected', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    await client.connect();
    await client.connect();
    await client.connect();
    await client.ping();
    await client.close();
  });
});

describe('close before connect emits no disconnected event', () => {
  it('does not emit "disconnected" if the client never reached connected', async () => {
    const client = new BridgeClient({ socketPath: '/run/does-not-exist.sock' });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    await client.close();
    expect(reasons).toHaveLength(0);
  });

  it('does not emit "disconnected" on socket close when no connected event was raised', async () => {
    server.on('connection', (conn) => {
      // never respond to ping; drop the connection after request
      conn.once('data', () => {
        conn.destroy();
      });
    });
    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    await expect(client.ping()).rejects.toThrow();
    await client.close();
    expect(reasons).not.toContain('socket-closed');
  });

  it('does not emit "disconnected" on socket "error" when never connected (synthesised on client socket)', async () => {
    server.on('connection', () => {
      // accept and never respond
    });
    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    await client.connect();
    // biome-ignore lint/complexity/useLiteralKeys: reaching into private state.
    const sock = (client as unknown as { socket?: import('node:net').Socket }).socket;
    // synthesise an "error" event before any successful ping — wasConnected is still false
    sock?.emit('error', new Error('pre-connected-error'));
    await new Promise((r) => setTimeout(r, 20));
    expect(reasons).not.toContain('socket-error');
    await client.close();
  });
});

describe('callImpl after close()', () => {
  it('rejects synchronously with transport error if called after close()', async () => {
    const client = new BridgeClient({ socketPath });
    await client.close();
    await expect(client.ping()).rejects.toMatchObject({ code: 'transport' });
  });
});

describe('handleFrame edge cases', () => {
  it('ignores stream frames addressed to an unknown id', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, { id: 'unknown-id', stream: 'stdout', data: 'orphan' });
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    await client.ping();
    await client.close();
  });

  it('drops response frames addressed to an unknown id without throwing', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: 'no-such-pending',
          ok: true,
          result: { ignored: true },
        });
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    await client.ping();
    await client.close();
  });

  it('drops a non-JSON frame payload silently', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        const garbage = Buffer.from('{not-json}', 'utf-8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(garbage.byteLength, 0);
        conn.write(Buffer.concat([header, garbage]));
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    await client.ping();
    await client.close();
  });

  it('does not emit "connected" if the first ping result lacks pong=true or version', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          // no version field
          result: { pong: true, hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    const reasons: unknown[] = [];
    client.on('connected', (info) => reasons.push(info));
    await client.ping();
    expect(reasons).toHaveLength(0);
    await client.close();
  });

  it('handles a non-object ping result without throwing', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, { id: req.id, ok: true, result: 'plain-string' });
      });
    });
    const client = new BridgeClient({ socketPath });
    await client.ping();
    await client.close();
  });

  it('falls back hostname=empty string when ping result has non-string hostname', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 42 },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    const evts: Array<{ hostname: string }> = [];
    client.on('connected', (info) => evts.push(info));
    await client.ping();
    expect(evts[0]?.hostname).toBe('');
    await client.close();
  });

  it('rejects with default "internal" code when an error response omits the error object', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        // ok:false without an error key
        sendFrame(conn, { id: req.id, ok: false });
      });
    });
    const client = new BridgeClient({ socketPath });
    await expect(client.fileWrite({ path: '/x', content: 'y' })).rejects.toMatchObject({
      code: 'internal',
    });
    await client.close();
  });
});

describe('safeEmit traps listener exceptions', () => {
  it('does not propagate listener throw to the network stack', async () => {
    server.on('connection', (conn) => {
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const onLog = vi.fn();
    const client = new BridgeClient({ socketPath, onLog });
    client.on('rtt', () => {
      throw new Error('listener-boom');
    });
    await client.ping();
    expect(onLog.mock.calls.some((c) => String(c[0]).includes('event listener threw'))).toBe(true);
    await client.close();
  });
});

describe('timeout firing', () => {
  it('rejects with code=timeout when the bridge never responds', async () => {
    server.on('connection', () => {
      // accept connection but never respond
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 50 });
    let caught: unknown;
    try {
      await client.fileWrite({ path: '/x', content: 'y' });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string })?.code).toBe('timeout');
    await client.close();
  }, 5000);
});

describe('socket.write callback error path', () => {
  it('rejects the pending call when socket.write reports an error', async () => {
    server.on('connection', (conn) => {
      conn.once('data', () => {
        conn.destroy();
      });
    });
    const client = new BridgeClient({ socketPath });
    await expect(client.hostAgentRestart()).rejects.toThrow(BridgeError);
    await client.close();
  });

  it('non-Error rejection on the pending call is stringified for the log message', async () => {
    server.on('connection', () => {
      // accept and stay silent
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 30_000 });
    const onLog = vi.fn();
    (client as unknown as { onLog: (m: string, meta?: unknown) => void }).onLog = onLog;
    const fileWritePromise = client.fileWrite({ path: '/x', content: 'y' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    // biome-ignore lint/complexity/useLiteralKeys: reaching into private pending map.
    const pending = (
      client as unknown as { pending: Map<string, { reject: (e: unknown) => void }> }
    ).pending;
    for (const [, p] of pending) {
      p.reject('plain-string-rejection');
    }
    pending.clear();
    const err = await fileWritePromise;
    expect(err).toBe('plain-string-rejection');
    await client.close();
  });

  it('synthetic write-callback error triggers transport retry with socket still set', async () => {
    let connectionCount = 0;
    server.on('connection', (conn) => {
      connectionCount++;
      if (connectionCount === 2) {
        conn.on('data', (chunk) => {
          const req = readReq(chunk);
          sendFrame(conn, {
            id: req.id,
            ok: true,
            result: { pong: true, version: 'v1', hostname: 'h' },
          });
        });
      }
    });
    const client = new BridgeClient({ socketPath });
    await client.connect();
    // biome-ignore lint/complexity/useLiteralKeys: reaching into private state for branch coverage.
    const sock = (client as unknown as { socket?: Socket }).socket as Socket;
    const realWrite = sock.write.bind(sock);
    let firstWrite = true;
    sock.write = ((buf: unknown, cbOrEnc: unknown, cb?: unknown) => {
      const callback =
        typeof cbOrEnc === 'function' ? cbOrEnc : (cb as undefined | ((err?: Error) => void));
      if (firstWrite) {
        firstWrite = false;
        // Synchronously fire the callback with an error — this drives lines
        // 329-332 (pending cleanup) AND, because retryOnTransport will run
        // before the socket-close handler clears this.socket, lines 289-291
        // (the "destroy + clear" branch).
        Promise.resolve().then(() => callback?.(new Error('synthetic-write-fail')));
        return true;
      }
      return realWrite(buf as never, cbOrEnc as never, cb as never);
    }) as never;
    const result = await client.ping();
    expect(result.hostname).toBe('h');
    expect(connectionCount).toBe(2);
    await client.close();
  });
});

describe('container streaming methods', () => {
  it('depotUpdate streams progress frames and resolves on done', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, { id: req.id, stream: 'stdout', data: 'Update state (0x5)' });
        sendFrame(conn, { id: req.id, ok: true, result: { exit_code: 0 } });
      });
    });
    const client = new BridgeClient({ socketPath });
    const frames: string[] = [];
    const result = await client.depotUpdate((f) => frames.push(f.data as string));
    expect(result.exit_code).toBe(0);
    expect(frames).toContain('Update state (0x5)');
    await client.close();
  });

  it('dockerPrune resolves with reclaim totals (no onStream callback)', async () => {
    server.on('connection', (conn) => {
      conn.once('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: {
            exit_code: 0,
            reclaimed_bytes: 1024,
            reclaimed_human: '1 KiB',
          },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    const result = await client.dockerPrune();
    expect(result.reclaimed_human).toBe('1 KiB');
    await client.close();
  });
});

describe('all wrapper methods dispatch the correct method id', () => {
  const methods: Array<[string, (c: BridgeClient) => Promise<unknown>]> = [
    ['host_info', (c) => c.hostInfo()],
    ['host_metrics', (c) => c.hostMetrics()],
    ['file_read', (c) => c.fileRead({ path: '/x' })],
    [
      'file_read_tail',
      (c) =>
        c.fileReadTail({
          path: '/var/lib/squad-panel/saved/x/y',
          max_bytes: 16,
        }),
    ],
    ['file_write', (c) => c.fileWrite({ path: '/x', content: 'y' })],
    ['file_atomic_write', (c) => c.fileAtomicWrite({ path: '/x', content: 'y' })],
    ['directory_delete', (c) => c.directoryDelete({ path: '/x' })],
    ['list_panel_dirs', (c) => c.listPanelDirs()],
    ['list_squad_containers', (c) => c.listSquadContainers()],
    ['ufw_rule', (c) => c.ufwRule({ action: 'add', port: 7787, proto: 'udp' })],
    ['process_info', (c) => c.processInfo({ pid: 1 })],
    [
      'container_run',
      (c) =>
        c.containerRun({
          server_id: '01999999-9999-7999-8999-999999999999',
          image: 'squad-server:latest',
          game_port: 7787,
          query_port: 27_165,
          beacon_port: 15_000,
          rcon_port: 21_114,
          configs_host: '/var/lib/squad-panel/configs/x',
          saved_host: '/var/lib/squad-panel/saved/x',
          depot_volume: 'squad-depot',
        }),
    ],
    [
      'container_run_rnsquadjs',
      (c) =>
        c.containerRunRnsquadjs({
          server_id: '01999999-9999-7999-8999-999999999999',
          env: { PANEL_BRIDGE_MODE: 'shadow' },
        }),
    ],
    ['container_start', (c) => c.containerStart({ name: 'squad-x' })],
    ['container_stop', (c) => c.containerStop({ name: 'squad-x' })],
    ['container_rm', (c) => c.containerRm({ name: 'squad-x' })],
    ['container_inspect', (c) => c.containerInspect({ name: 'squad-x' })],
    ['container_stats', (c) => c.containerStats({ name: 'squad-x' })],
    ['squad_log_retention_sweep', (c) => c.squadLogRetentionSweep()],
    ['host_agent_restart', (c) => c.hostAgentRestart()],
  ];

  for (const [methodName, invoke] of methods) {
    it(`dispatches ${methodName}`, async () => {
      let received: string | undefined;
      server.on('connection', (conn) => {
        conn.once('data', (chunk) => {
          const req = readReq(chunk);
          received = req.method;
          sendFrame(conn, { id: req.id, ok: true, result: {} });
        });
      });
      const client = new BridgeClient({ socketPath, defaultTimeoutMs: 5_000 });
      await invoke(client);
      expect(received).toBe(methodName);
      await client.close();
    });
  }
});

describe('close() while a call is pending', () => {
  it('rejects every pending call with transport "client closed"', async () => {
    server.on('connection', () => {
      // accept and stay silent so the call hangs
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 60_000 });
    const inFlight = client.fileWrite({ path: '/x', content: 'y' }).catch((err) => err);
    await new Promise((r) => setTimeout(r, 50));
    await client.close();
    const err = await inFlight;
    expect((err as { code?: string }).code).toBe('transport');
  }, 5000);
});

describe('socket "error" after a successful connect emits disconnected("socket-error")', () => {
  it('routes the error event into the disconnected stream', async () => {
    let connSeen: Socket | undefined;
    server.on('connection', (conn) => {
      connSeen = conn;
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    await client.ping();
    await new Promise((r) => setTimeout(r, 10));
    // Synthesise an "error" event on the server-facing connection. The
    // client's socket is the symmetric peer so it raises 'error' too via
    // 'close' — but to definitively trip the 'error' branch we emit on
    // the client's underlying socket directly.
    // biome-ignore lint/complexity/useLiteralKeys: reaching into private state intentionally for branch coverage.
    const clientSock = (client as unknown as { socket?: Socket }).socket;
    expect(clientSock).toBeDefined();
    clientSock?.emit('error', new Error('synthetic-rst'));
    await new Promise((r) => setTimeout(r, 20));
    expect(reasons).toContain('socket-error');
    connSeen?.destroy();
    await client.close();
  });
});

describe('socket "close" after a successful connect emits disconnected("socket-closed")', () => {
  it('routes the close event into the disconnected stream (server tears down)', async () => {
    let connSeen: Socket | undefined;
    server.on('connection', (conn) => {
      connSeen = conn;
      conn.on('data', (chunk) => {
        const req = readReq(chunk);
        sendFrame(conn, {
          id: req.id,
          ok: true,
          result: { pong: true, version: 'v1', hostname: 'h' },
        });
      });
    });
    const client = new BridgeClient({ socketPath });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    await client.ping();
    connSeen?.end();
    await new Promise((r) => setTimeout(r, 30));
    expect(reasons).toContain('socket-closed');
    await client.close();
  });
});
