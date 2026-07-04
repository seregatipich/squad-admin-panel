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
