import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { events } from '@squad/db';
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
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    get: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
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

/**
 * Fake RCON server for seeding-transition tests: unlike
 * `makePollingRconServer`, `ListPlayers` reflects a mutable player count
 * (`state.playerCount`) so a test can drive the supervisor through a real
 * live -> seeding crossing across multiple polls.
 */
function makeSeedingRconServer(state: {
  playerCount: number;
  mapName: string;
}): Promise<{ server: Server; port: number }> {
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
          if (packet.body === 'ListPlayers') {
            const lines = ['----- Active Players -----'];
            for (let i = 0; i < state.playerCount; i++) {
              const steamId = `76561198${String(i).padStart(9, '0')}`;
              lines.push(
                `ID: ${i} | Online IDs: EOS: ${'a'.repeat(32)} steam: ${steamId} | Name: P${i} | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: Rifleman`,
              );
            }
            lines.push('----- Recently Disconnected Players [Max of 15] -----');
            writePacket(packet.id, lines.join('\n'));
            continue;
          }
          if (packet.body === 'ListSquads') {
            writePacket(packet.id, '');
            continue;
          }
          if (packet.body === 'ShowServerInfo') {
            writePacket(
              packet.id,
              JSON.stringify({
                MapName_s: state.mapName,
                GameMode_s: 'RAAS',
                ServerTickRate: 49.7,
              }),
            );
            continue;
          }
          if (packet.body === 'ShowNextMap') {
            writePacket(packet.id, 'Next level is X, layer is X');
            continue;
          }
          writePacket(packet.id, '');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Fake db supporting the full drizzle chains touched by a real (non-empty)
 * `ListPlayers` poll: `upsertPlayers`/`accruePlayerKitTime` (persist.ts)
 * additionally `select`/`insert`/`update` the `players`/`playerNameHistory`/
 * `auditLog` tables every poll. `select(...).where(...).limit(1)` always
 * resolves to `[]` (no matching row), which is sufficient here since these
 * tests only care about the seeding-specific `events` insert — every other
 * table's insert/update is a no-op success.
 */
function makeSeedingDb(insertedEvents: Array<Record<string, unknown>>) {
  const resolvedChain = () => {
    const chain = Promise.resolve(undefined) as Promise<undefined> & Record<string, unknown>;
    chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
    chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
    chain.returning = vi.fn(() => Promise.resolve([]));
    return chain;
  };

  return {
    transaction: vi.fn(async (callback: (tx: { execute: ReturnType<typeof vi.fn> }) => unknown) =>
      callback({ execute: vi.fn(async () => [{ changed_count: 0 }]) }),
    ),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((v: Record<string, unknown>) => {
        if (table === events) insertedEvents.push(v);
        return resolvedChain();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    })),
  } as never;
}

describe('RconSupervisor seeding transitions', () => {
  it('crossing the seed threshold emits exactly one started envelope + events insert + live-bus publish; a repeat poll at the same count emits no further transition but refreshes the state key; a progress-only change still publishes', async () => {
    const state = { playerCount: 80, mapName: 'Gorodok_RAAS_v1' };
    const { server, port } = await makeSeedingRconServer(state);
    const redis = makeRedis() as unknown as {
      set: ReturnType<typeof vi.fn>;
      publish: ReturnType<typeof vi.fn>;
      xadd: ReturnType<typeof vi.fn>;
    };
    const insertedEvents: Array<Record<string, unknown>> = [];
    const db = makeSeedingDb(insertedEvents);
    const supervisor = new RconSupervisor({
      db,
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 30,
    });
    const liveTarget: Target = {
      ...target,
      serverId: 'srv-seeding',
      port,
      queryPort: port + 1000,
      seedLiveAt: 60,
      seedHysteresis: 5,
    };

    const stateKey = 'seeding:state:srv-seeding';
    const seedingEnvelopeTypes = () =>
      redis.xadd.mock.calls
        .map((call) => JSON.parse(call[call.length - 1] as string).type as string)
        .filter((t) => t.startsWith('server.seeding'));

    try {
      await supervisor.reconcile([liveTarget]);

      // First poll establishes the initial state at 80 players (>= liveAt):
      // 'live', no transition, no events insert.
      const deadline1 = Date.now() + 3000;
      while (Date.now() < deadline1 && !redis.set.mock.calls.some((c) => c[0] === stateKey)) {
        await sleep(15);
      }
      expect(insertedEvents).toHaveLength(0);

      // Cross the threshold: 80 -> 40 (< liveAt - hysteresis = 55).
      state.playerCount = 40;
      const deadline2 = Date.now() + 3000;
      while (Date.now() < deadline2 && insertedEvents.length === 0) {
        await sleep(15);
      }
      expect(insertedEvents).toHaveLength(1);
      expect(insertedEvents[0]).toMatchObject({
        kind: 'server.seeding_started',
        serverId: 'srv-seeding',
      });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(seedingEnvelopeTypes()).toEqual(['server.seeding_started']);

      // Repeat polls at the same count: no further transition, but the
      // redis state key keeps refreshing every poll.
      const setCallsBeforeRepeat = redis.set.mock.calls.filter((c) => c[0] === stateKey).length;
      await sleep(90);
      const setCallsAfterRepeat = redis.set.mock.calls.filter((c) => c[0] === stateKey).length;
      expect(setCallsAfterRepeat).toBeGreaterThan(setCallsBeforeRepeat);
      expect(insertedEvents).toHaveLength(1);

      // Progress-only change (still seeding, no transition) still
      // publishes a live-bus 'server.seeding' update.
      const publishCallsBefore = redis.publish.mock.calls.length;
      state.playerCount = 45;
      const deadline3 = Date.now() + 3000;
      const sawUpdatedProgress = () =>
        redis.publish.mock.calls.some((call) => {
          try {
            const parsed = JSON.parse(call[1] as string) as {
              type: string;
              data: { current_players: number };
            };
            return parsed.type === 'server.seeding' && parsed.data.current_players === 45;
          } catch {
            return false;
          }
        });
      while (Date.now() < deadline3 && !sawUpdatedProgress()) {
        await sleep(15);
      }
      expect(sawUpdatedProgress()).toBe(true);
      expect(redis.publish.mock.calls.length).toBeGreaterThan(publishCallsBefore);
      expect(insertedEvents).toHaveLength(1);
    } finally {
      await supervisor.stop();
      await closeServer(server);
    }
  }, 10_000);

  it('a seed layer at high player count still emits seeding_started (acceptance criterion 2)', async () => {
    const state = { playerCount: 100, mapName: 'Sumari_Seed_v1' };
    const { server, port } = await makeSeedingRconServer(state);
    const redis = makeRedis() as unknown as { xadd: ReturnType<typeof vi.fn> };
    const insertedEvents: Array<Record<string, unknown>> = [];
    const db = makeSeedingDb(insertedEvents);
    const supervisor = new RconSupervisor({
      db,
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 30,
    });
    const liveTarget: Target = {
      ...target,
      serverId: 'srv-seed-layer',
      port,
      queryPort: port + 1000,
      seedLiveAt: 60,
      seedHysteresis: 5,
    };

    try {
      await supervisor.reconcile([liveTarget]);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && insertedEvents.length === 0) {
        await sleep(15);
      }
      expect(insertedEvents).toHaveLength(1);
      expect(insertedEvents[0]).toMatchObject({ kind: 'server.seeding_started' });
      const payload = insertedEvents[0]?.payload as { player_count: number; layer: string | null };
      expect(payload.player_count).toBe(100);
      expect(payload.layer).toBe('Sumari_Seed_v1');
    } finally {
      await supervisor.stop();
      await closeServer(server);
    }
  }, 5000);
});

describe('RconSupervisor command queue', () => {
  it('executes queued operator commands over the connected worker RCON session', async () => {
    const { server, port, commands } = await makePollingRconServer();
    const redis = makeRedis() as unknown as {
      set: ReturnType<typeof vi.fn>;
      publish: ReturnType<typeof vi.fn>;
      xadd: ReturnType<typeof vi.fn>;
      xgroup: ReturnType<typeof vi.fn>;
      xreadgroup: ReturnType<typeof vi.fn>;
      xautoclaim: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      xack: ReturnType<typeof vi.fn>;
    };
    redis.xreadgroup
      .mockResolvedValueOnce([
        [
          'rcon:commands:srv-command',
          [
            [
              '1700-0',
              [
                'request',
                JSON.stringify({
                  request_id: 'req-command',
                  command: 'AdminBroadcast',
                  args: ['Queue smoke'],
                  enqueued_at: '2026-07-07T12:00:00.000Z',
                }),
              ],
            ],
          ],
        ],
      ])
      .mockResolvedValue(null);
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 10_000,
    });
    const liveTarget: Target = {
      ...target,
      serverId: 'srv-command',
      port,
      queryPort: port + 1000,
    };

    try {
      await supervisor.reconcile([liveTarget]);

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !commands.includes('AdminBroadcast Queue smoke')) {
        await sleep(25);
      }

      expect(commands).toContain('AdminBroadcast Queue smoke');
      expect(redis.xgroup).toHaveBeenCalledWith(
        'CREATE',
        'rcon:commands:srv-command',
        'worker-rcon:commands:v1',
        '0',
        'MKSTREAM',
      );
      expect(redis.set).toHaveBeenCalledWith(
        'rcon:command-result:req-command',
        expect.stringContaining('"ok":true'),
        'EX',
        120,
      );
      expect(redis.xack).toHaveBeenCalledWith(
        'rcon:commands:srv-command',
        'worker-rcon:commands:v1',
        '1700-0',
      );
    } finally {
      await supervisor.stop();
      await closeServer(server);
    }
  }, 5000);
});
