import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAPPED_EVENTS } from '../src/panel-bridge/event-map.js';
import PanelBridge from '../src/panel-bridge.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';

class FakeServer extends EventEmitter {
  constructor(players = []) {
    super();
    this.players = players;
  }
}

function makeRedis() {
  return {
    xadd: vi.fn().mockResolvedValue('1-0'),
    set: vi.fn().mockResolvedValue('OK'),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}

function makePlugin(options = {}, players = []) {
  const server = new FakeServer(players);
  const redis = makeRedis();
  const plugin = new PanelBridge(server, { serverId: SERVER_ID, ...options }, {});
  plugin.createRedis = () => redis;
  return { plugin, server, redis };
}

const envelopesFrom = (redis) => redis.xadd.mock.calls.map((call) => JSON.parse(call.at(-1)));

describe('PanelBridge options', () => {
  it('declares the SquadJS option specification the config generator writes', () => {
    const spec = PanelBridge.optionsSpecification;
    expect(spec.mode.default).toBe('shadow');
    expect(spec.redisUrl.default).toBe('redis://127.0.0.1:6379');
    expect(spec.serverId.required).toBe(true);
    expect(PanelBridge.defaultEnabled).toBe(false);
    expect(typeof PanelBridge.description).toBe('string');
  });

  it('declares no connector options, so an empty connectors block boots', () => {
    for (const option of Object.values(PanelBridge.optionsSpecification)) {
      expect(option.connector).toBeUndefined();
    }
  });

  it('refuses to construct without a serverId', () => {
    expect(() => new PanelBridge(new FakeServer(), {}, {})).toThrow(/serverId is required/);
  });

  it('defaults to shadow mode for an unknown mode value', () => {
    const { plugin } = makePlugin({ mode: 'nonsense' });
    expect(plugin.mode).toBe('shadow');
  });
});

describe('PanelBridge mount', () => {
  let mounted;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(async () => {
    if (mounted) await mounted.unmount();
  });

  it('subscribes to every mapped event plus the poll and RCON error signals', async () => {
    const { plugin, server } = makePlugin();
    mounted = plugin;

    await plugin.mount();

    for (const event of MAPPED_EVENTS) expect(server.listenerCount(event)).toBe(1);
    expect(server.listenerCount('UPDATED_PLAYER_INFORMATION')).toBe(1);
    expect(server.listenerCount('RCON_ERROR')).toBe(1);
  });

  it('publishes a connected status and starts the heartbeat on mount', async () => {
    const { plugin, redis } = makePlugin({ mode: 'production' });
    mounted = plugin;

    await plugin.mount();
    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(
      `sidecar:status:${SERVER_ID}`,
      expect.stringContaining('"state":"connected"'),
      'EX',
      300,
    );
    expect(redis.set.mock.calls.some((c) => c[0] === `worker:heartbeat:sidecar:${SERVER_ID}`)).toBe(
      true,
    );
  });

  it('publishes a disconnected status on RCON_ERROR', async () => {
    const { plugin, server, redis } = makePlugin({ mode: 'production' });
    mounted = plugin;
    await plugin.mount();

    server.emit('RCON_ERROR', new Error('boom'));
    await Promise.resolve();

    expect(redis.set.mock.calls.at(-1)?.[1]).toContain('"state":"disconnected"');
  });

  it('maps a subscribed event onto the stream', async () => {
    const { plugin, server, redis } = makePlugin();
    mounted = plugin;
    await plugin.mount();

    server.emit('ADMIN_BROADCAST', { message: 'gg', time: '2026-09-08T03:00:00.000Z' });
    await Promise.resolve();

    expect(envelopesFrom(redis)).toEqual([
      expect.objectContaining({ type: 'admin.broadcast', payload: { message: 'gg' } }),
    ]);
  });

  it('derives player.name_changed from the player-list poll', async () => {
    const players = [{ steamID: '76561199000000002', eosID: 'b'.repeat(32), name: 'PanelBravo' }];
    const { plugin, server, redis } = makePlugin({ mode: 'production' }, players);
    mounted = plugin;
    await plugin.mount();

    server.emit('UPDATED_PLAYER_INFORMATION');
    await Promise.resolve();
    server.players = [{ steamID: '76561199000000002', eosID: 'b'.repeat(32), name: 'Renamed' }];
    server.emit('UPDATED_PLAYER_INFORMATION');
    await Promise.resolve();

    expect(envelopesFrom(redis)).toEqual([
      expect.objectContaining({
        type: 'player.name_changed',
        payload: {
          steam_id64: '76561199000000002',
          eos_id: 'b'.repeat(32),
          name: 'Renamed',
          old_name: 'PanelBravo',
          new_name: 'Renamed',
        },
      }),
    ]);
  });

  it('forgets a disconnected player so a rejoin is not reported as a rename', async () => {
    const player = { steamID: '76561199000000002', eosID: 'b'.repeat(32), name: 'PanelBravo' };
    const { plugin, server, redis } = makePlugin({ mode: 'production' }, [player]);
    mounted = plugin;
    await plugin.mount();

    server.emit('UPDATED_PLAYER_INFORMATION');
    await Promise.resolve();
    server.emit('PLAYER_DISCONNECTED', { time: '2026-09-08T03:00:00.000Z', player });
    await Promise.resolve();
    server.players = [{ ...player, name: 'Renamed' }];
    server.emit('UPDATED_PLAYER_INFORMATION');
    await Promise.resolve();

    expect(envelopesFrom(redis).filter((e) => e.type === 'player.name_changed')).toEqual([]);
  });
});

describe('PanelBridge unmount', () => {
  it('removes every listener, stops the heartbeat and closes Redis', async () => {
    const { plugin, server, redis } = makePlugin();
    await plugin.mount();

    await plugin.unmount();

    for (const event of [...MAPPED_EVENTS, 'UPDATED_PLAYER_INFORMATION', 'RCON_ERROR']) {
      expect(server.listenerCount(event)).toBe(0);
    }
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing after unmount', async () => {
    const { plugin, server, redis } = makePlugin();
    await plugin.mount();
    await plugin.unmount();
    redis.xadd.mockClear();

    server.emit('ADMIN_BROADCAST', { message: 'late', time: '2026-09-08T03:00:00.000Z' });
    await Promise.resolve();

    expect(redis.xadd).not.toHaveBeenCalled();
  });
});
