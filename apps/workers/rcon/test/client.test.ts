import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { RconClient } from '../src/client.js';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeOpts(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 25575,
    password: 'testpass',
    log: makeLogger(),
    connectTimeoutMs: 200,
    commandTimeoutMs: 200,
    ...overrides,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface ClientInternals {
  socket?: Socket;
}

function captureExecWrites(client: RconClient): string[] {
  const sock = (client as unknown as ClientInternals).socket;
  if (!sock) throw new Error('expected connected rcon socket');
  const sentBodies: string[] = [];
  const outgoing = new RconPacketStream();
  const originalWrite = sock.write.bind(sock);
  sock.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown) => {
    if (Buffer.isBuffer(chunk)) {
      for (const packet of outgoing.push(chunk)) {
        if (packet.type === SERVERDATA_EXECCOMMAND) sentBodies.push(packet.body);
      }
    }
    return originalWrite(chunk as never, encodingOrCb as never, cb as never);
  }) as Socket['write'];
  return sentBodies;
}

describe('RconClient', () => {
  it('constructs without error', () => {
    expect(() => new RconClient(makeOpts())).not.toThrow();
  });

  it('exec() throws "rcon not connected" when not connected', async () => {
    const client = new RconClient(makeOpts());
    await expect(client.exec('ShowServerInfo')).rejects.toThrow('rcon not connected');
  });

  it('close() is idempotent when never connected', async () => {
    const client = new RconClient(makeOpts());
    await expect(client.close()).resolves.not.toThrow();
    await expect(client.close()).resolves.not.toThrow();
  });

  it('close() rejects pending exec calls with "rcon closed"', async () => {
    const client = new RconClient(makeOpts());
    const p1 = client.exec('ListPlayers').catch((e) => e.message);
    const p2 = client.exec('ShowCurrentMap').catch((e) => e.message);
    await client.close();
    await expect(p1).resolves.toBe('rcon closed');
    await expect(p2).resolves.toBe('rcon closed');
  });

  it('connect() times out when host is unreachable', async () => {
    const client = new RconClient(makeOpts({ port: 19999, connectTimeoutMs: 100 }));
    await expect(client.connect()).rejects.toThrow();
  }, 2000);

  it('close() after close() does not throw', async () => {
    const client = new RconClient(makeOpts());
    await client.close();
    await expect(client.close()).resolves.not.toThrow();
  });

  it('serializes exec calls so the next command waits for the previous probe response', async () => {
    let releaseFirstProbe: (() => void) | undefined;
    let resolveFirstProbeReceived: (() => void) | undefined;
    const firstProbeReceived = new Promise<void>((resolve) => {
      resolveFirstProbeReceived = resolve;
    });

    const server = await new Promise<Server>((resolve) => {
      const fixture = createServer((sock: Socket) => {
        const stream = new RconPacketStream();
        let firstProbeHeld = false;
        const writePacket = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
          if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
        };

        sock.on('error', () => undefined);
        sock.on('data', (chunk) => {
          const packets = stream.push(chunk);
          for (const packet of packets) {
            if (packet.type === SERVERDATA_AUTH) {
              writePacket(packet.id, '');
              writePacket(packet.id, '', SERVERDATA_AUTH_RESPONSE);
              continue;
            }

            if (packet.type !== SERVERDATA_EXECCOMMAND) continue;

            if (packet.body === '') {
              if (!firstProbeHeld) {
                firstProbeHeld = true;
                releaseFirstProbe = () => {
                  writePacket(packet.id, '');
                };
                resolveFirstProbeReceived?.();
                continue;
              }
              writePacket(packet.id, '');
              continue;
            }

            writePacket(packet.id, `result:${packet.body}`);
          }
        });
      });
      fixture.listen(0, '127.0.0.1', () => resolve(fixture));
    });
    const port = (server.address() as AddressInfo).port;
    const client = new RconClient(makeOpts({ port, commandTimeoutMs: 500 }));

    try {
      await client.connect();
      const sentBodies = captureExecWrites(client);
      const first = client.exec('FirstCommand');
      first.catch(() => undefined);
      await firstProbeReceived;
      expect(sentBodies).toEqual(['FirstCommand', '']);

      const second = client.exec('SecondCommand');
      second.catch(() => undefined);
      await sleep(30);

      expect(sentBodies).toEqual(['FirstCommand', '']);

      releaseFirstProbe?.();
      await expect(first).resolves.toBe('result:FirstCommand');
      await expect(second).resolves.toBe('result:SecondCommand');
      expect(sentBodies).toEqual(['FirstCommand', '', 'SecondCommand', '']);
    } finally {
      await client.close().catch(() => undefined);
      await closeServer(server);
    }
  });
});
