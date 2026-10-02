import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parsePrivateHostAllowlist } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { RconClient } from '../src/client.js';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_CHAT_VALUE,
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

  it('refuses a password with CR, LF or NUL before opening a socket (#34)', async () => {
    const received: Buffer[] = [];
    let connections = 0;
    const server = createServer((sock) => {
      connections++;
      sock.on('data', (chunk) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const password of ['x\r\nSET session:forged 1', 'x\ny', 'x\u0000y']) {
        const client = new RconClient(makeOpts({ port, password }));
        await expect(client.connect()).rejects.toThrow(/line break or NUL/);
        await client.close();
      }
      await sleep(50);
      expect(connections).toBe(0);
      expect(received).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
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

  it('delivers broadcast packets interleaved with a multi-chunk response', async () => {
    const chatBody =
      '[ChatAll] [Online IDs:EOS: 0002aaaa000000000000000000000001 steam: 76561199000000001] PanelAlpha : hello panel';

    const server = await new Promise<Server>((resolve) => {
      const fixture = createServer((sock: Socket) => {
        const stream = new RconPacketStream();
        const writePacket = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
          if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
        };

        sock.on('error', () => undefined);
        sock.on('data', (chunk) => {
          for (const packet of stream.push(chunk)) {
            if (packet.type === SERVERDATA_AUTH) {
              writePacket(packet.id, '');
              writePacket(packet.id, '', SERVERDATA_AUTH_RESPONSE);
              continue;
            }
            if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
            if (packet.body === '') {
              writePacket(packet.id, '');
              continue;
            }
            // Squad pushes chat between the chunks of a long response.
            writePacket(packet.id, 'first-half|');
            writePacket(0, chatBody, SERVERDATA_CHAT_VALUE);
            writePacket(packet.id, 'second-half');
          }
        });
      });
      fixture.listen(0, '127.0.0.1', () => resolve(fixture));
    });
    const port = (server.address() as AddressInfo).port;
    const onBroadcast = vi.fn();
    const client = new RconClient(makeOpts({ port, commandTimeoutMs: 500, onBroadcast }));

    try {
      await client.connect();
      await expect(client.exec('ListPlayers')).resolves.toBe('first-half|second-half');
      expect(onBroadcast).toHaveBeenCalledTimes(1);
      expect(onBroadcast).toHaveBeenCalledWith(chatBody);
    } finally {
      await client.close().catch(() => undefined);
      await closeServer(server);
    }
  });
});

/**
 * A fixture that answers exactly like a live Squad server (captured
 * 2026-09-07): the real response, one empty echo of the probe, then the
 * broken 21-byte second echo. Before the decoder fix the second exec on the
 * same socket timed out because the junk mis-framed everything after it.
 */
function makeSquadLikeServer(): Promise<{ server: Server; port: number; commands: string[] }> {
  const commands: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      const write = (buf: Buffer) => {
        if (!sock.destroyed) sock.write(buf);
      };
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            write(encodePacket({ id: packet.id, type: SERVERDATA_RESPONSE_VALUE, body: '' }));
            write(encodePacket({ id: packet.id, type: SERVERDATA_AUTH_RESPONSE, body: '' }));
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          if (packet.body === '') {
            const probeId = Buffer.alloc(4);
            probeId.writeInt32LE(packet.id, 0);
            // Legitimate echo …
            write(encodePacket({ id: packet.id, type: SERVERDATA_RESPONSE_VALUE, body: '' }));
            // … then the broken one: size 10 header, id, type 0, \\0\\0 and 7 junk bytes.
            write(
              Buffer.concat([
                Buffer.from('0a000000', 'hex'),
                probeId,
                Buffer.from('00000000', 'hex'),
                Buffer.from('0000', 'hex'),
                Buffer.from('00010000000000', 'hex'),
              ]),
            );
            continue;
          }
          commands.push(packet.body);
          write(
            encodePacket({
              id: packet.id,
              type: SERVERDATA_RESPONSE_VALUE,
              body: `result:${packet.body}`,
            }),
          );
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, commands });
    });
  });
}

describe("RconClient against Squad's broken probe reply", () => {
  it('keeps executing commands on one socket after the junk bytes', async () => {
    const { server, port, commands } = await makeSquadLikeServer();
    const log = makeLogger();
    const client = new RconClient(makeOpts({ port, log, commandTimeoutMs: 1500 }));
    try {
      await client.connect();
      expect(await client.exec('ListPlayers')).toBe('result:ListPlayers');
      expect(await client.exec('ListSquads')).toBe('result:ListSquads');
      expect(await client.exec('ShowServerInfo')).toBe('result:ShowServerInfo');
      expect(commands).toEqual(['ListPlayers', 'ListSquads', 'ShowServerInfo']);
      expect((log as { error: ReturnType<typeof vi.fn> }).error).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await closeServer(server);
    }
  });
});

describe('RconClient restricted-address guard (#30, finding #333)', () => {
  async function listenOnLoopback(): Promise<{
    server: Server;
    port: number;
    accepted: () => number;
  }> {
    let accepted = 0;
    const server = createServer((sock) => {
      accepted += 1;
      sock.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port, accepted: () => accepted };
  }

  it('refuses a loopback literal without opening a socket', async () => {
    const { server, port, accepted } = await listenOnLoopback();
    try {
      const client = new RconClient(
        makeOpts({ host: '127.0.0.1', port, refuseRestrictedAddresses: true }),
      );
      await expect(client.connect()).rejects.toThrow(/restricted address/);
      await sleep(20);
      expect(accepted()).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a hostname that resolves to loopback (DNS rebinding)', async () => {
    const { server, port, accepted } = await listenOnLoopback();
    try {
      const client = new RconClient(
        makeOpts({ host: 'localhost', port, refuseRestrictedAddresses: true }),
      );
      await expect(client.connect()).rejects.toThrow(/restricted address/);
      await sleep(20);
      expect(accepted()).toBe(0);
    } finally {
      await closeServer(server);
    }
  });
});

describe('RconClient resolved-address guard with a stub resolver (#96)', () => {
  /**
   * A stand-in for `dns.lookup` that answers with `addresses` in whichever
   * callback shape the caller asked for (`all: true` gets the list).
   */
  function stubLookup(addresses: string[]) {
    const calls: string[] = [];
    const lookup = ((
      hostname: string,
      options: { all?: boolean },
      callback: (err: null, address: unknown, family?: number) => void,
    ) => {
      calls.push(hostname);
      const entries = addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }));
      if (options?.all) callback(null, entries);
      else callback(null, entries[0]?.address, entries[0]?.family);
    }) as never;
    return { lookup, calls };
  }

  async function connectError(addresses: string[], extra = {}): Promise<Error> {
    const { lookup, calls } = stubLookup(addresses);
    const client = new RconClient(
      makeOpts({
        host: 'rcon.example.com',
        refuseRestrictedAddresses: true,
        dnsLookup: lookup,
        ...extra,
      }),
    );
    const error = await client.connect().then(
      () => new Error('connected'),
      (err: Error) => err,
    );
    expect(calls).toContain('rcon.example.com');
    await client.close();
    return error;
  }

  it.each([
    ['loopback', ['127.0.0.1']],
    ['IPv6 loopback', ['::1']],
    ['link-local (cloud metadata)', ['169.254.169.254']],
    ['unspecified', ['0.0.0.0']],
    ['IPv6 unspecified', ['::']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['one loopback among public addresses', ['93.184.216.34', '127.0.0.1']],
  ])('refuses a public hostname resolving to %s', async (_label, addresses) => {
    const error = await connectError(addresses);
    expect(error.message).toMatch(/restricted address/);
    expect((error as NodeJS.ErrnoException).code).toBe('ERESTRICTED');
  });

  it('refuses a private address outside the allowlist', async () => {
    const error = await connectError(['10.9.8.7'], { privateHostAllowlist: [] });
    expect(error.message).toMatch(/private address outside the allowlist/);
  });

  it('lets a public answer through to the dial', async () => {
    // 192.0.2.1 is TEST-NET-1: not restricted, and nothing answers there.
    const error = await connectError(['192.0.2.1']);
    expect((error as NodeJS.ErrnoException).code).not.toBe('ERESTRICTED');
  });

  it('does not consult the resolver for a panel-hosted server', async () => {
    const { lookup, calls } = stubLookup(['127.0.0.1']);
    // `localhost` is a name, so a refusing client would resolve it through the
    // stub; without the flag the stub must stay unused (nothing listens on port 9).
    const client = new RconClient(
      makeOpts({ host: 'localhost', port: 9, dnsLookup: lookup, connectTimeoutMs: 500 }),
    );
    await client.connect().catch(() => undefined);
    await client.close();
    expect(calls).toEqual([]);
  });
});

describe('RconClient private-network allowlist (#30, finding #333)', () => {
  it('refuses a private literal outside the allowlist', async () => {
    const client = new RconClient(
      makeOpts({
        host: '10.255.255.1',
        port: 21_114,
        refuseRestrictedAddresses: true,
        privateHostAllowlist: [],
      }),
    );
    await expect(client.connect()).rejects.toThrow(/private address/);
  });

  it('does not refuse a private literal inside the allowlist', async () => {
    const client = new RconClient(
      makeOpts({
        host: '10.255.255.1',
        port: 21_114,
        connectTimeoutMs: 50,
        refuseRestrictedAddresses: true,
        privateHostAllowlist: parsePrivateHostAllowlist('10.255.0.0/16'),
      }),
    );
    const error = await client.connect().then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message ?? '').not.toMatch(/private address/);
  });

  it('keeps a private literal reachable when no allowlist is configured', async () => {
    const client = new RconClient(
      makeOpts({
        host: '10.255.255.1',
        port: 21_114,
        connectTimeoutMs: 50,
        refuseRestrictedAddresses: true,
      }),
    );
    const error = await client.connect().then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message ?? '').not.toMatch(/private address/);
  });
});

describe('RconClient keepalive (#976)', () => {
  it('pings an idle connection but stays silent while commands keep it busy', async () => {
    const { server, port, commands } = await makeSquadLikeServer();
    const client = new RconClient(makeOpts({ port, commandTimeoutMs: 1500, keepaliveMs: 100 }));
    try {
      await client.connect();
      for (let i = 0; i < 6; i++) {
        await client.exec('ListPlayers');
        await sleep(40);
      }
      expect(commands.filter((command) => command === 'ShowServerInfo')).toEqual([]);

      await sleep(350);
      expect(commands).toContain('ShowServerInfo');
    } finally {
      await client.close();
      await closeServer(server);
    }
  });
});
