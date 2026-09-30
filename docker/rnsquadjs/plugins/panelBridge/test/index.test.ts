import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelBridgeContext } from '../src/index.js';
import { startPanelBridge } from '../src/index.js';

const redis = vi.hoisted(() => ({
  xadd: vi.fn(),
  set: vi.fn(),
  quit: vi.fn(),
  on: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => redis),
}));

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const socketDirs: string[] = [];

const uniqueSocketPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'panelbridge-index-'));
  socketDirs.push(dir);
  return join(dir, 'rcon.sock');
};

const cleanupSocketDirs = (): void => {
  for (const dir of socketDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

const STEAM_ID = '76561198000000001';
const EOS_ID = '0002a10186d9414496bf20d22d3860ba';

// Shaped like squad-logs@c0136352 TPlayerConnected / TPlayerDisconnected:
// connect has no name, disconnect has no steam id (upper-case RedpointEOS id).
const connectRaw = {
  raw: '[2026.04.24-16.12.12:945][412]LogSquad: PostLogin: NewPlayer: …',
  time: '2026.04.24-16.12.12:945',
  chainID: '412',
  playerController: 'BP_PlayerController_C_2147481234',
  ip: '203.0.113.7',
  eosID: EOS_ID,
  steamID: STEAM_ID,
  event: 'PLAYER_CONNECTED',
};
const disconnectRaw = {
  raw: '[2026.04.24-17.00.00:000][900]LogNet: UChannel::Close: …',
  time: '2026.04.24-17.00.00:000',
  chainID: '900',
  ip: '203.0.113.7',
  playerController: 'BP_PlayerController_C_2147481234',
  eosID: EOS_ID.toUpperCase(),
  event: 'PLAYER_DISCONNECTED',
};

const makeContext = (
  emitter: EventEmitter,
  onUnsubscribe: () => void,
  findPlayer: PanelBridgeContext['findPlayer'] = (eosId) =>
    eosId === EOS_ID ? { steamID: STEAM_ID, name: 'Sergei' } : undefined,
): PanelBridgeContext => ({
  serverId: SERVER_ID,
  emitter,
  onStatus: () => onUnsubscribe,
  findPlayer,
});

const publishedEnvelopes = (): Array<{ type: string; ts: string; payload: unknown }> =>
  redis.xadd.mock.calls.map((call) => JSON.parse(String(call.at(-1))));

describe('startPanelBridge teardown', () => {
  beforeEach(() => {
    redis.xadd.mockResolvedValue('0-1');
    redis.set.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PANEL_BRIDGE_MODE;
    cleanupSocketDirs();
  });

  it('unwires every emitter listener, calls the status unsubscribe, and ignores late events', async () => {
    const emitter = new EventEmitter();
    const statusUnsubscribe = vi.fn();
    const bridge = await startPanelBridge(makeContext(emitter, statusUnsubscribe));

    expect(emitter.listenerCount('PLAYER_CONNECTED')).toBe(1);
    expect(emitter.listenerCount('CHAT_MESSAGE')).toBe(1);

    await bridge.stop();

    expect(emitter.listenerCount('PLAYER_CONNECTED')).toBe(0);
    expect(emitter.listenerCount('CHAT_MESSAGE')).toBe(0);
    expect(statusUnsubscribe).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);

    redis.xadd.mockClear();
    emitter.emit('PLAYER_CONNECTED', connectRaw);
    await Promise.resolve();
    expect(redis.xadd).not.toHaveBeenCalled();
  });
});

describe('production-mode type filter', () => {
  beforeEach(() => {
    redis.xadd.mockResolvedValue('0-1');
    redis.set.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PANEL_BRIDGE_MODE;
    delete process.env.PANEL_BRIDGE_SOCKET;
    cleanupSocketDirs();
  });

  it('publishes only legacy-parity types in production, everything in shadow', async () => {
    const chatRaw = {
      chat: 'ChatAll',
      eosID: EOS_ID,
      steamID: STEAM_ID,
      name: 'Sergei',
      message: 'hi',
      time: new Date('2026-04-24T10:00:00.000Z'),
    };

    process.env.PANEL_BRIDGE_MODE = 'shadow';
    const shadowEmitter = new EventEmitter();
    const shadowBridge = await startPanelBridge(makeContext(shadowEmitter, vi.fn()));
    shadowEmitter.emit('CHAT_MESSAGE', chatRaw);
    await Promise.resolve();
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    await shadowBridge.stop();
    redis.xadd.mockClear();

    process.env.PANEL_BRIDGE_MODE = 'production';
    process.env.PANEL_BRIDGE_SOCKET = uniqueSocketPath();
    const prodEmitter = new EventEmitter();
    const prodBridge = await startPanelBridge(makeContext(prodEmitter, vi.fn()));
    prodEmitter.emit('CHAT_MESSAGE', chatRaw);
    await Promise.resolve();
    expect(redis.xadd).not.toHaveBeenCalled();
    prodEmitter.emit('PLAYER_CONNECTED', connectRaw);
    await Promise.resolve();
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    await prodBridge.stop();
  });
});

describe('production-mode identity resolution (#33)', () => {
  beforeEach(() => {
    redis.xadd.mockResolvedValue('0-1');
    redis.set.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
    process.env.PANEL_BRIDGE_MODE = 'production';
    process.env.PANEL_BRIDGE_SOCKET = uniqueSocketPath();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PANEL_BRIDGE_MODE;
    delete process.env.PANEL_BRIDGE_SOCKET;
    cleanupSocketDirs();
  });

  it('publishes upstream connect/disconnect with the name and steam id the shared schema requires', async () => {
    const emitter = new EventEmitter();
    const bridge = await startPanelBridge(makeContext(emitter, vi.fn()));

    emitter.emit('PLAYER_CONNECTED', connectRaw);
    emitter.emit('PLAYER_DISCONNECTED', disconnectRaw);
    await Promise.resolve();

    expect(publishedEnvelopes()).toMatchObject([
      {
        type: 'player.connected',
        ts: '2026-04-24T16:12:12.945Z',
        payload: { steam_id64: STEAM_ID, eos_id: EOS_ID, name: 'Sergei', ip: null },
      },
      {
        type: 'player.disconnected',
        ts: '2026-04-24T17:00:00.000Z',
        payload: { steam_id64: STEAM_ID, eos_id: EOS_ID, reason: null },
      },
    ]);
    await bridge.stop();
  });

  it('resolves a disconnect from the remembered connect after the player left state.players', async () => {
    const emitter = new EventEmitter();
    let online = true;
    const bridge = await startPanelBridge(
      makeContext(emitter, vi.fn(), (eosId) =>
        online && eosId === EOS_ID ? { steamID: STEAM_ID, name: 'Sergei' } : undefined,
      ),
    );

    emitter.emit('PLAYER_CONNECTED', connectRaw);
    online = false;
    emitter.emit('PLAYER_DISCONNECTED', disconnectRaw);
    await Promise.resolve();

    expect(publishedEnvelopes().map((e) => e.payload)).toEqual([
      { steam_id64: STEAM_ID, eos_id: EOS_ID, name: 'Sergei', ip: null },
      { steam_id64: STEAM_ID, eos_id: EOS_ID, reason: null },
    ]);
    await bridge.stop();
  });

  it('drops a production event whose identity cannot be resolved instead of publishing an invalid payload', async () => {
    const emitter = new EventEmitter();
    const bridge = await startPanelBridge(makeContext(emitter, vi.fn(), () => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    emitter.emit('PLAYER_CONNECTED', connectRaw);
    emitter.emit('PLAYER_DISCONNECTED', disconnectRaw);
    emitter.emit('NEW_GAME', { time: '2026.04.24-16.12.12:945' });
    await Promise.resolve();

    expect(publishedEnvelopes().map((e) => e.type)).toEqual(['match.started']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    await bridge.stop();
  });

  it('still publishes an unresolved connect to the shadow stream for parity analysis', async () => {
    process.env.PANEL_BRIDGE_MODE = 'shadow';
    const emitter = new EventEmitter();
    const bridge = await startPanelBridge(makeContext(emitter, vi.fn(), () => undefined));

    emitter.emit('PLAYER_CONNECTED', connectRaw);
    await Promise.resolve();

    expect(publishedEnvelopes().map((e) => e.payload)).toEqual([
      { steam_id64: STEAM_ID, eos_id: EOS_ID, name: null, ip: null },
    ]);
    await bridge.stop();
  });
});

describe('RCON status key refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    redis.xadd.mockResolvedValue('0-1');
    redis.set.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete process.env.PANEL_BRIDGE_MODE;
  });

  const statusWrites = (key: string) => redis.set.mock.calls.filter((call) => call[0] === key);

  it('rewrites the status key while RCON stays connected, so the 300s TTL never lapses', async () => {
    process.env.PANEL_BRIDGE_MODE = 'shadow';
    const statusKey = `rnsquadjs:status:${SERVER_ID}:shadow`;
    const bridge = await startPanelBridge({
      serverId: SERVER_ID,
      emitter: new EventEmitter(),
      onStatus: (onChange) => {
        onChange('connected');
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const [first] = statusWrites(statusKey);
    expect(first?.slice(2)).toEqual(['EX', 300]);
    const initial = JSON.parse(first?.[1] as string);

    // Well past the 300s TTL with no RCON state change at all.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const writes = statusWrites(statusKey);
    expect(writes.length).toBeGreaterThanOrEqual(60);
    const lastWrite = writes[writes.length - 1];
    expect(lastWrite?.slice(2)).toEqual(['EX', 300]);
    // A refresh keeps the key alive but does not pretend the state changed.
    expect(JSON.parse(lastWrite?.[1] as string)).toEqual(initial);

    await bridge.stop();
    const afterStop = statusWrites(statusKey).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusWrites(statusKey).length).toBe(afterStop);
  });

  it('refreshes nothing before the first RCON status is known', async () => {
    process.env.PANEL_BRIDGE_MODE = 'shadow';
    const bridge = await startPanelBridge({
      serverId: SERVER_ID,
      emitter: new EventEmitter(),
      onStatus: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusWrites(`rnsquadjs:status:${SERVER_ID}:shadow`)).toHaveLength(0);
    await bridge.stop();
  });
});

describe('production mode exposes no RCON socket (#1347)', () => {
  beforeEach(() => {
    redis.xadd.mockResolvedValue('0-1');
    redis.set.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PANEL_BRIDGE_MODE;
    delete process.env.PANEL_BRIDGE_SOCKET;
    cleanupSocketDirs();
  });

  it('never binds PANEL_BRIDGE_SOCKET, so no unauthenticated RCON channel exists', async () => {
    process.env.PANEL_BRIDGE_MODE = 'production';
    const socketPath = uniqueSocketPath();
    process.env.PANEL_BRIDGE_SOCKET = socketPath;

    const bridge = await startPanelBridge(makeContext(new EventEmitter(), vi.fn()));

    expect(existsSync(socketPath)).toBe(false);
    await bridge.stop();
  });
});
