import { RCON_COMMAND_GROUP, rconCommandResultKey, rconCommandStream } from '@squad/shared-types';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { buildOperatorCommand, RconCommandQueue } from '../src/commands.js';

function commandRequest(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'req-1',
    command: 'AdminBroadcast',
    args: ['Server restart in 15 seconds'],
    enqueued_at: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeRedis(entries: Array<[string, string[]]> | null) {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi
      .fn()
      .mockResolvedValueOnce(entries ? [[rconCommandStream('srv-1'), entries]] : null),
    set: vi.fn().mockResolvedValue('OK'),
    xack: vi.fn().mockResolvedValue(1),
  } as unknown as Redis & {
    xgroup: ReturnType<typeof vi.fn>;
    xreadgroup: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
  };
}

describe('buildOperatorCommand', () => {
  it('builds only the whitelisted operator commands', () => {
    expect(buildOperatorCommand(commandRequest())).toBe(
      'AdminBroadcast Server restart in 15 seconds',
    );
    expect(buildOperatorCommand(commandRequest({ command: 'AdminEndMatch', args: [] }))).toBe(
      'AdminEndMatch',
    );
    expect(
      buildOperatorCommand(commandRequest({ command: 'AdminReloadServerConfig', args: [] })),
    ).toBe('AdminReloadServerConfig');
  });

  it('rejects unsupported commands and unsafe broadcast text', () => {
    expect(() => buildOperatorCommand(commandRequest({ command: 'AdminKick' }))).toThrow(
      /unsupported/i,
    );
    expect(() =>
      buildOperatorCommand(commandRequest({ args: ['first line\nsecond line'] })),
    ).toThrow(/unsafe/i);
  });
});

describe('RconCommandQueue', () => {
  it('creates the consumer group from the beginning of the stream', async () => {
    const redis = makeRedis(null);
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute: vi.fn(),
    });

    await queue.ensureGroup();

    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '0',
      'MKSTREAM',
    );
  });

  it('swallows BUSYGROUP when the consumer group already exists', async () => {
    const redis = makeRedis(null);
    redis.xgroup.mockRejectedValueOnce(new Error('BUSYGROUP Consumer Group name already exists'));
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute: vi.fn(),
    });

    await expect(queue.ensureGroup()).resolves.toBeUndefined();
  });

  it('executes one stream command, stores the result and acknowledges the entry', async () => {
    const redis = makeRedis([['1700-0', ['request', JSON.stringify(commandRequest())]]]);
    const execute = vi.fn().mockResolvedValue('Broadcast sent');
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute,
      blockMs: 1,
      consumerName: 'test-consumer',
    });

    const processed = await queue.processOnce();

    expect(processed).toBe(1);
    expect(redis.xreadgroup).toHaveBeenCalledWith(
      'GROUP',
      RCON_COMMAND_GROUP,
      'test-consumer',
      'COUNT',
      '10',
      'BLOCK',
      '1',
      'STREAMS',
      rconCommandStream('srv-1'),
      '>',
    );
    expect(execute).toHaveBeenCalledWith('AdminBroadcast Server restart in 15 seconds');
    expect(redis.set).toHaveBeenCalledWith(
      rconCommandResultKey('req-1'),
      expect.stringContaining('"ok":true'),
      'EX',
      120,
    );
    expect(redis.xack).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '1700-0',
    );
  });

  it('stores a failed result and acknowledges when RCON execution throws', async () => {
    const redis = makeRedis([['1700-1', ['request', JSON.stringify(commandRequest())]]]);
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute: vi.fn().mockRejectedValue(new Error('rcon exec timeout')),
      blockMs: 1,
    });

    await expect(queue.processOnce()).resolves.toBe(1);

    const stored = JSON.parse(String(redis.set.mock.calls[0]?.[1]));
    expect(stored).toMatchObject({
      ok: false,
      server_id: 'srv-1',
      request_id: 'req-1',
      error: 'rcon exec timeout',
    });
    expect(redis.xack).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '1700-1',
    );
  });

  it('rejects malformed operator commands with a result instead of executing them', async () => {
    const redis = makeRedis([
      ['1700-2', ['request', JSON.stringify(commandRequest({ command: 'AdminKick' }))]],
    ]);
    const execute = vi.fn();
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute,
      blockMs: 1,
    });

    await expect(queue.processOnce()).resolves.toBe(1);

    expect(execute).not.toHaveBeenCalled();
    const stored = JSON.parse(String(redis.set.mock.calls[0]?.[1]));
    expect(stored.ok).toBe(false);
    expect(stored.error).toMatch(/unsupported/i);
    expect(redis.xack).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '1700-2',
    );
  });
});
