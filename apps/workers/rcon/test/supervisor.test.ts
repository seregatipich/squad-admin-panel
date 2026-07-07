import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

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
  } as never;
}

function makeDb() {
  return {} as never;
}

const target: Target = {
  serverId: 'srv-001',
  host: '127.0.0.1',
  port: 29100,
  queryPort: 27165,
  tickrate: 50,
  password: 'testpass',
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makePollingRconServer(): Promise<{ server: Server; port: number; commands: string[] }> {
  const commands: string[] = [];
  const responses: Record<string, string> = {
    ListPlayers:
      '----- Active Players -----\n----- Recently Disconnected Players [Max of 15] -----',
    ListSquads: [
      'Team ID: 1 (United States Army)',
      'ID: 1 | Name: INF | Size: 9 | Locked: False | Creator Name: Alpha | Creator Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678',
    ].join('\n'),
    ShowServerInfo: JSON.stringify({
      MapName_s: 'Gorodok_RAAS_v1',
      GameMode_s: 'RAAS',
      ServerTickRate: 49.7,
    }),
    ShowNextMap: 'Next level is Fallujah, layer is Fallujah_RAAS_v1',
  };

  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
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

          commands.push(packet.body);
          writePacket(packet.id, responses[packet.body] ?? '');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, commands });
    });
  });
}

describe('RconSupervisor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a per-server supervisor on reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    expect(supervisor.size()).toBe(0);
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(1);
    await supervisor.stop();
    expect(supervisor.size()).toBe(0);
  });

  it('removes stopped target on reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(1);
    await supervisor.reconcile([]);
    expect(supervisor.size()).toBe(0);
  });

  it('does not re-add existing target on repeated reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    await supervisor.reconcile([target]);
    const sizeBefore = supervisor.size();
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(sizeBefore);
    await supervisor.stop();
  });
});

describe('RconSupervisor polling', () => {
  it('polls ListSquads and ShowNextMap and writes the squad cache', async () => {
    const { server, port, commands } = await makePollingRconServer();
    const redis = makeRedis() as unknown as {
      set: ReturnType<typeof vi.fn>;
      publish: ReturnType<typeof vi.fn>;
      xadd: ReturnType<typeof vi.fn>;
    };
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 25,
    });
    const liveTarget: Target = {
      ...target,
      serverId: 'srv-poll',
      port,
      queryPort: port + 1000,
    };

    try {
      await supervisor.reconcile([liveTarget]);

      const deadline = Date.now() + 3000;
      let squadsPayload: { squads: Array<{ name: string; team_id: number; size: number }> } | null =
        null;
      let statusPayload: { state?: string; next_layer?: string; squad_count?: number } | null =
        null;

      while (Date.now() < deadline && (!squadsPayload || !statusPayload?.squad_count)) {
        await sleep(25);
        for (const call of redis.set.mock.calls) {
          const [key, value] = call;
          if (key === 'rcon:squads:srv-poll' && typeof value === 'string') {
            squadsPayload = JSON.parse(value) as typeof squadsPayload;
          }
          if (key === 'rcon:status:srv-poll' && typeof value === 'string') {
            const parsed = JSON.parse(value) as typeof statusPayload;
            if (parsed?.state === 'connected' && parsed.squad_count) statusPayload = parsed;
          }
        }
      }

      expect(commands).toEqual(
        expect.arrayContaining(['ListPlayers', 'ListSquads', 'ShowServerInfo', 'ShowNextMap']),
      );
      expect(squadsPayload?.squads[0]).toMatchObject({
        name: 'INF',
        team_id: 1,
        size: 9,
      });
      expect(statusPayload).toMatchObject({
        next_layer: 'Fallujah_RAAS_v1',
        squad_count: 1,
      });
    } finally {
      await supervisor.stop();
      await closeServer(server);
    }
  }, 5000);
});
