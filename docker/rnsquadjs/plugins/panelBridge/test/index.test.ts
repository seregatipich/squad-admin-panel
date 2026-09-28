import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelBridgeContext } from '../src/index.js';
import { startPanelBridge } from '../src/index.js';

const redis = vi.hoisted(() => ({
  xadd: vi.fn(),
  set: vi.fn(),
  quit: vi.fn(),
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

const makeContext = (emitter: EventEmitter, onUnsubscribe: () => void): PanelBridgeContext => ({
  serverId: SERVER_ID,
  emitter,
  rconExec: vi.fn(async () => 'ok'),
  onStatus: () => onUnsubscribe,
});

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
    emitter.emit('PLAYER_CONNECTED', {
      steamID: '76561198000000001',
      eosID: '0002eos00000000000000000000000a1',
      name: 'Sergei',
      time: '2026-04-24T10:00:00.000Z',
    });
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
      steamID: '76561198000000001',
      name: 'Sergei',
      message: 'hi',
      time: '2026-04-24T10:00:00.000Z',
    };
    const connectRaw = {
      steamID: '76561198000000001',
      eosID: '0002eos00000000000000000000000a1',
      name: 'Sergei',
      time: '2026-04-24T10:00:00.000Z',
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
      rconExec: vi.fn(async () => 'ok'),
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
      rconExec: vi.fn(async () => 'ok'),
      onStatus: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusWrites(`rnsquadjs:status:${SERVER_ID}:shadow`)).toHaveLength(0);
    await bridge.stop();
  });
});
