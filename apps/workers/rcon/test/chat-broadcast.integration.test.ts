/**
 * Chat reaches the panel only over RCON.
 *
 * Squad does not write in-game chat to SquadGame.log, so the log-ingest chat
 * parser never matches on a live server and the chat panel stayed empty
 * ("в эфире", no messages). This exercises the real path end to end: a fake
 * Squad server pushes an unsolicited chat packet at an authenticated
 * supervisor, and the message must land on the live bus the web client reads.
 */
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_CHAT_VALUE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

const EOS = '0002aaaa000000000000000000000001';
const STEAM = '76561199000000001';
const CHAT_LINE = `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] PanelAlpha : hello panel`;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(0),
    xadd: vi.fn().mockResolvedValue('0-0'),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    get: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
  };
}

/** Identity lookups resolve empty: the live frame must still be published. */
function makeDb() {
  const chain: Record<string, unknown> = { limit: vi.fn(async () => []) };
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  return { select: vi.fn(() => chain), insert: vi.fn() } as never;
}

/** A fake Squad server that authenticates, then pushes broadcasts on demand. */
function fakeSquadServer(): Promise<{
  server: Server;
  port: number;
  broadcast: (body: string) => void;
}> {
  const sockets: Socket[] = [];
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            sock.write(encodePacket({ id: packet.id, type: SERVERDATA_RESPONSE_VALUE, body: '' }));
            sock.write(encodePacket({ id: packet.id, type: SERVERDATA_AUTH_RESPONSE, body: '' }));
            sockets.push(sock);
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          sock.write(encodePacket({ id: packet.id, type: SERVERDATA_RESPONSE_VALUE, body: '' }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        broadcast: (body) => {
          for (const sock of sockets) {
            if (!sock.destroyed) {
              sock.write(encodePacket({ id: 0, type: SERVERDATA_CHAT_VALUE, body }));
            }
          }
        },
      });
    });
  });
}

describe('RCON chat broadcasts', () => {
  it('publishes an in-game chat line onto the live bus', async () => {
    const { server, port, broadcast } = await fakeSquadServer();
    const redis = makeRedis();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 60_000,
      rosterIntervalMs: 60_000,
    });
    const target: Target = {
      serverId: 'srv-chat',
      host: '127.0.0.1',
      port,
      queryPort: 27165,
      password: 'pw',
    };

    try {
      await supervisor.reconcile([target]);

      const deadline = Date.now() + 5_000;
      let published: Record<string, unknown> | undefined;
      while (Date.now() < deadline && !published) {
        broadcast(CHAT_LINE);
        await sleep(25);
        published = redis.publish.mock.calls
          .filter(([channel]) => channel === 'live-bus')
          .map(([, payload]) => JSON.parse(payload as string) as Record<string, unknown>)
          .find((frame) => frame.type === 'chat.message');
      }

      expect(published).toBeDefined();
      expect(published?.data).toMatchObject({
        server_id: 'srv-chat',
        channel: 'ChatAll',
        player_name: 'PanelAlpha',
        steam_id64: STEAM,
        eos_id: EOS,
        message: 'hello panel',
      });
    } finally {
      await supervisor.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it('ignores non-chat broadcasts on the same packet type', async () => {
    const { server, port, broadcast } = await fakeSquadServer();
    const redis = makeRedis();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 60_000,
      rosterIntervalMs: 60_000,
    });

    try {
      await supervisor.reconcile([
        { serverId: 'srv-chat', host: '127.0.0.1', port, queryPort: 27165, password: 'pw' },
      ]);
      for (let i = 0; i < 40 && redis.publish.mock.calls.length === 0; i += 1) {
        broadcast(
          `[Online Ids:EOS: ${EOS} steam: ${STEAM}] PanelAlpha has possessed admin camera.`,
        );
        await sleep(25);
      }

      const chatFrames = redis.publish.mock.calls
        .filter(([channel]) => channel === 'live-bus')
        .map(([, payload]) => JSON.parse(payload as string) as Record<string, unknown>)
        .filter((frame) => frame.type === 'chat.message');
      expect(chatFrames).toEqual([]);
    } finally {
      await supervisor.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
