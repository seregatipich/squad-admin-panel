import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type SupervisorOptions, type Target } from '../src/supervisor.js';

/**
 * The live path of worker-rcon: how fast a change on the game server reaches
 * `rcon:status` / `rcon:roster` and the `rcon:status:changed` fan-out. Every
 * test pushes the full DB poll (`pollIntervalMs`) past its horizon and passes
 * an empty `db`, so anything here that touched the database would throw.
 */

interface GameState {
  players: number;
  map: string;
  nextLayer: string;
  queue: number;
  tickrate: number;
}

function makeGameServer(state: GameState): Promise<{
  server: Server;
  port: number;
  commands: string[];
}> {
  const commands: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      const reply = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
        if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
      };
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            reply(packet.id, '');
            reply(packet.id, '', SERVERDATA_AUTH_RESPONSE);
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          if (packet.body === '') {
            reply(packet.id, '');
            continue;
          }
          commands.push(packet.body);
          switch (packet.body) {
            case 'ListPlayers': {
              const lines = ['----- Active Players -----'];
              for (let i = 0; i < state.players; i++) {
                lines.push(
                  `ID: ${i} | Online IDs: EOS: ${String(i).padStart(32, 'a')} steam: 76561198${String(i).padStart(9, '0')} | Name: P${i} | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: Rifleman`,
                );
              }
              lines.push('----- Recently Disconnected Players [Max of 15] -----');
              reply(packet.id, lines.join('\n'));
              break;
            }
            case 'ShowServerInfo':
              reply(
                packet.id,
                JSON.stringify({
                  MapName_s: state.map,
                  GameMode_s: 'RAAS',
                  ServerTickRate: state.tickrate,
                  PublicQueue_I: String(state.queue),
                }),
              );
              break;
            case 'ShowNextMap':
              reply(packet.id, `Next level is Fallujah, layer is ${state.nextLayer}`);
              break;
            default:
              reply(packet.id, '');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, commands });
    });
  });
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

type RedisMock = ReturnType<typeof makeRedis>;

function lastStatus(redis: RedisMock, serverId: string): Record<string, unknown> | null {
  const calls = redis.set.mock.calls.filter(([key]) => key === `rcon:status:${serverId}`);
  const last = calls.at(-1);
  return last ? (JSON.parse(String(last[1])) as Record<string, unknown>) : null;
}

function statusPublishes(redis: RedisMock, serverId: string): Array<Record<string, unknown>> {
  return redis.publish.mock.calls
    .filter(([channel]) => channel === 'rcon:status:changed')
    .map(([, raw]) => JSON.parse(String(raw)) as Record<string, unknown>)
    .filter((msg) => msg.server_id === serverId);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function start(
  serverId: string,
  state: GameState,
  opts: Partial<SupervisorOptions> = {},
): Promise<{ supervisor: RconSupervisor; redis: RedisMock; commands: string[] }> {
  const { server, port, commands } = await makeGameServer(state);
  const redis = makeRedis();
  const supervisor = new RconSupervisor({
    db: {} as never,
    redis: redis as never,
    log: makeLogger(),
    pollIntervalMs: 600_000,
    rosterIntervalMs: 600_000,
    infoIntervalMs: 600_000,
    hintDebounceMs: 5,
    hintFollowUpMs: 600_000,
    ...opts,
  });
  const target: Target = {
    serverId,
    host: '127.0.0.1',
    port,
    queryPort: port + 1000,
    password: 'pw',
  };
  cleanups.push(async () => {
    await supervisor.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });
  await supervisor.reconcile([target]);
  return { supervisor, redis, commands };
}

describe('worker-rcon live path', () => {
  it('fills roster and server info right after connecting, without waiting for any timer', async () => {
    const state = {
      players: 3,
      map: 'Gorodok_RAAS_v1',
      nextLayer: 'Fallujah_RAAS_v1',
      queue: 4,
      tickrate: 49.5,
    };
    const { redis } = await start('srv-connect', state);

    await waitFor(() => {
      const status = lastStatus(redis, 'srv-connect');
      return status?.player_count === 3 && status?.current_map === 'Gorodok_RAAS_v1';
    });
    expect(lastStatus(redis, 'srv-connect')).toMatchObject({
      state: 'connected',
      player_count: 3,
      squad_count: 0,
      current_map: 'Gorodok_RAAS_v1',
      next_layer: 'Fallujah_RAAS_v1',
      game_mode: 'RAAS',
      public_queue: 4,
      tickrate_rt: 49.5,
    });
    expect(redis.set.mock.calls.some(([key]) => key === 'rcon:roster:srv-connect')).toBe(true);
  });

  it('re-polls the roster at once on a hint, not on the next timer tick', async () => {
    const state = { players: 1, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { supervisor, redis } = await start('srv-hint', state);
    await waitFor(() => lastStatus(redis, 'srv-hint')?.player_count === 1);

    state.players = 2;
    const hintedAt = Date.now();
    expect(supervisor.hint('srv-hint', ['roster'])).toBe(true);
    await waitFor(() => lastStatus(redis, 'srv-hint')?.player_count === 2, 1000);
    // Timers are 10 minutes out: only the hint can explain this.
    expect(Date.now() - hintedAt).toBeLessThan(1000);
    expect(statusPublishes(redis, 'srv-hint').at(-1)).toMatchObject({
      state: 'connected',
      player_count: 2,
    });
  });

  it('re-reads server info on an info hint (a new match) and keeps the roster fields', async () => {
    const state = { players: 5, map: 'Old_Map', nextLayer: 'Next_A', queue: 0, tickrate: 50 };
    const { supervisor, redis } = await start('srv-match', state);
    await waitFor(() => lastStatus(redis, 'srv-match')?.current_map === 'Old_Map');

    state.map = 'New_Map';
    state.nextLayer = 'Next_B';
    supervisor.hint('srv-match', ['info']);
    await waitFor(() => lastStatus(redis, 'srv-match')?.current_map === 'New_Map', 1000);
    expect(lastStatus(redis, 'srv-match')).toMatchObject({
      current_map: 'New_Map',
      next_layer: 'Next_B',
      player_count: 5,
    });
  });

  it('coalesces a burst of hints into one RCON round-trip', async () => {
    const state = { players: 2, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { supervisor, redis, commands } = await start('srv-burst', state, {
      hintDebounceMs: 50,
    });
    await waitFor(() => lastStatus(redis, 'srv-burst')?.player_count === 2);
    await sleep(30);
    const before = commands.filter((c) => c === 'ListPlayers').length;

    for (let i = 0; i < 10; i++) supervisor.hint('srv-burst', ['roster']);
    await sleep(250);
    expect(commands.filter((c) => c === 'ListPlayers').length - before).toBe(1);
  });

  it('repeats a hinted roster refresh once, to catch a player RCON listed late', async () => {
    const state = { players: 1, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { supervisor, redis } = await start('srv-follow', state, { hintFollowUpMs: 100 });
    await waitFor(() => lastStatus(redis, 'srv-follow')?.player_count === 1);
    // The initial connect refresh schedules a follow-up too; let it pass.
    await sleep(200);

    supervisor.hint('srv-follow', ['roster']);
    await sleep(40);
    // The log line arrived before RCON caught up: the first read still sees 1.
    state.players = 2;
    await waitFor(() => lastStatus(redis, 'srv-follow')?.player_count === 2, 1000);
  });

  it('publishes rcon:status:changed only when a rendered field changes, not on every refresh', async () => {
    const state = { players: 4, map: 'M', nextLayer: 'L', queue: 1, tickrate: 50 };
    const { redis } = await start('srv-quiet', state, {
      rosterIntervalMs: 20,
      infoIntervalMs: 20,
    });
    await waitFor(
      () => redis.set.mock.calls.filter(([key]) => key === 'rcon:status:srv-quiet').length >= 12,
    );
    const quiet = statusPublishes(redis, 'srv-quiet').length;
    // Tickrate moves on every read and must not count as a change.
    state.tickrate = 42.1;
    await waitFor(() => lastStatus(redis, 'srv-quiet')?.tickrate_rt === 42.1);
    // A few more refreshes on the new tickrate, still no publish.
    const writes = redis.set.mock.calls.length;
    await waitFor(() => redis.set.mock.calls.length >= writes + 6);
    expect(statusPublishes(redis, 'srv-quiet').length).toBe(quiet);

    state.players = 5;
    await waitFor(() => statusPublishes(redis, 'srv-quiet').at(-1)?.player_count === 5);
    expect(statusPublishes(redis, 'srv-quiet').length).toBe(quiet + 1);
  });

  it('retries a failed status publish on the next write even if nothing changed', async () => {
    const state = { players: 1, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { supervisor, redis } = await start('srv-retry', state);
    await waitFor(() => lastStatus(redis, 'srv-retry')?.current_map === 'M');
    const published = statusPublishes(redis, 'srv-retry').length;

    state.players = 2;
    redis.publish.mockRejectedValueOnce(new Error('redis blip'));
    supervisor.hint('srv-retry', ['roster']);
    await waitFor(() => lastStatus(redis, 'srv-retry')?.player_count === 2);
    await sleep(30);
    supervisor.hint('srv-retry', ['roster']);
    await waitFor(() => statusPublishes(redis, 'srv-retry').length > published);
    expect(statusPublishes(redis, 'srv-retry').at(-1)).toMatchObject({ player_count: 2 });
  });

  it('drops a hint for a server this worker does not poll', async () => {
    const state = { players: 0, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { supervisor } = await start('srv-known', state);
    expect(supervisor.hint('srv-unknown', ['roster'])).toBe(false);
  });

  it('refreshes server info on its own cadence', async () => {
    const state = { players: 0, map: 'A', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { redis } = await start('srv-info', state, { infoIntervalMs: 30 });
    await waitFor(() => lastStatus(redis, 'srv-info')?.current_map === 'A');
    state.map = 'B';
    await waitFor(() => lastStatus(redis, 'srv-info')?.current_map === 'B', 1000);
  });
});

describe('worker-rcon command queue connection', () => {
  it('parks the blocking command-queue read on its own connection, not the one status writes use', async () => {
    const state = { players: 1, map: 'M', nextLayer: 'L', queue: 0, tickrate: 50 };
    const { server, port } = await makeGameServer(state);
    const queueConn = { ...makeRedis(), on: vi.fn(), disconnect: vi.fn() };
    const redis = { ...makeRedis(), duplicate: vi.fn(() => queueConn) };
    const supervisor = new RconSupervisor({
      db: {} as never,
      redis: redis as never,
      log: makeLogger(),
      pollIntervalMs: 600_000,
      rosterIntervalMs: 600_000,
      infoIntervalMs: 600_000,
    });
    try {
      await supervisor.reconcile([
        { serverId: 'srv-queue', host: '127.0.0.1', port, queryPort: port + 1000, password: 'pw' },
      ]);
      await waitFor(() => queueConn.xreadgroup.mock.calls.length > 0);
      await waitFor(() => lastStatus(redis, 'srv-queue')?.player_count === 1);
      // A `XREADGROUP BLOCK` on the shared connection delayed every status
      // write behind it by up to the block window.
      expect(redis.xreadgroup).not.toHaveBeenCalled();
      expect(queueConn.set.mock.calls.some(([key]) => String(key).startsWith('rcon:status:'))).toBe(
        false,
      );
    } finally {
      await supervisor.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(queueConn.disconnect).toHaveBeenCalled();
  });
});
