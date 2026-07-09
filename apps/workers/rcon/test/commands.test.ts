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

function makeRedis(
  entries: Array<[string, string[]]> | null,
  claimedEntries: Array<[string, string[]]> = [],
  existingResults: Record<string, string> = {},
) {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi
      .fn()
      .mockResolvedValueOnce(entries ? [[rconCommandStream('srv-1'), entries]] : null),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', claimedEntries, []]),
    get: vi.fn((key: string) => Promise.resolve(existingResults[key] ?? null)),
    set: vi.fn().mockResolvedValue('OK'),
    xack: vi.fn().mockResolvedValue(1),
  } as unknown as Redis & {
    xgroup: ReturnType<typeof vi.fn>;
    xreadgroup: ReturnType<typeof vi.fn>;
    xautoclaim: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
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
    expect(
      buildOperatorCommand(
        commandRequest({
          command: 'AdminWarn',
          args: ['76561198000000123', 'Please stop teamkilling'],
        }),
      ),
    ).toBe('AdminWarn 76561198000000123 Please stop teamkilling');
  });

  it('rejects unsupported commands and unsafe broadcast text', () => {
    expect(() => buildOperatorCommand(commandRequest({ command: 'AdminKick' }))).toThrow(
      /unsupported/i,
    );
    expect(() =>
      buildOperatorCommand(commandRequest({ args: ['first line\nsecond line'] })),
    ).toThrow(/unsafe/i);
  });

  it('rejects AdminWarn with the wrong argument count', () => {
    expect(() =>
      buildOperatorCommand(commandRequest({ command: 'AdminWarn', args: ['target-only'] })),
    ).toThrow(/exactly two arguments/i);
    expect(() =>
      buildOperatorCommand(
        commandRequest({ command: 'AdminWarn', args: ['target', 'msg', 'extra'] }),
      ),
    ).toThrow(/exactly two arguments/i);
  });

  it('rejects AdminWarn with unsafe target or message text', () => {
    expect(() =>
      buildOperatorCommand(commandRequest({ command: 'AdminWarn', args: ['target\nid', 'hello'] })),
    ).toThrow(/unsafe/i);
    expect(() =>
      buildOperatorCommand(
        commandRequest({ command: 'AdminWarn', args: ['target', 'line one\nline two'] }),
      ),
    ).toThrow(/unsafe/i);
    expect(() =>
      buildOperatorCommand(commandRequest({ command: 'AdminWarn', args: ['', 'hello'] })),
    ).toThrow(/is required/i);
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

  it('reclaims idle pending entries and processes them through the same executor', async () => {
    const redis = makeRedis(null, [
      [
        '1700-9',
        [
          'request',
          JSON.stringify(commandRequest({ request_id: 'req-claim', args: ['Reclaimed'] })),
        ],
      ],
    ]);
    const execute = vi.fn().mockResolvedValue('Broadcast sent');
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute,
      consumerName: 'consumer-b',
      reclaimMinIdleMs: 60_000,
    });

    const processed = await queue.reclaimPendingOnce();

    expect(processed).toBe(1);
    expect(redis.xautoclaim).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      'consumer-b',
      60_000,
      '0-0',
      'COUNT',
      '10',
    );
    expect(execute).toHaveBeenCalledWith('AdminBroadcast Reclaimed');
    expect(redis.set).toHaveBeenCalledWith(
      rconCommandResultKey('req-claim'),
      expect.stringContaining('"ok":true'),
      'EX',
      120,
    );
    expect(redis.xack).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '1700-9',
    );
  });

  it('acknowledges claimed entries without executing again when the result already exists', async () => {
    const existingResult = JSON.stringify({
      ok: true,
      server_id: 'srv-1',
      request_id: 'req-done',
      command: 'AdminEndMatch',
      response: '',
      completed_at: '2026-07-07T12:00:01.000Z',
      duration_ms: 12,
    });
    const redis = makeRedis(
      null,
      [
        [
          '1700-10',
          [
            'request',
            JSON.stringify(commandRequest({ request_id: 'req-done', command: 'AdminEndMatch' })),
          ],
        ],
      ],
      { [rconCommandResultKey('req-done')]: existingResult },
    );
    const execute = vi.fn();
    const queue = new RconCommandQueue({
      redis,
      log: makeLogger(),
      serverId: 'srv-1',
      execute,
      consumerName: 'consumer-b',
    });

    await expect(queue.reclaimPendingOnce()).resolves.toBe(1);

    expect(execute).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith(
      rconCommandStream('srv-1'),
      RCON_COMMAND_GROUP,
      '1700-10',
    );
  });
});
