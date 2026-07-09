import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { sendRconCommandViaWorker } from '../src/lib/rcon-worker-command.js';

function makeRedis(status: unknown, result: unknown = null) {
  const store = new Map<string, string>();
  if (status !== undefined) {
    store.set('rcon:status:srv-1', typeof status === 'string' ? status : JSON.stringify(status));
  }
  if (result !== null) {
    store.set('rcon:command-result:req-1', JSON.stringify(result));
  }
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    xadd: vi.fn().mockResolvedValue('1700-0'),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
  } as unknown as Redis & {
    get: ReturnType<typeof vi.fn>;
    xadd: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
}

describe('sendRconCommandViaWorker', () => {
  it('does not enqueue when worker-rcon is not connected', async () => {
    const redis = makeRedis({ state: 'connecting' });

    const result = await sendRconCommandViaWorker(redis, {
      serverId: 'srv-1',
      command: 'AdminEndMatch',
      requestId: 'req-1',
      timeoutMs: 1,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ attempted: false, reason: 'worker_not_connected' });
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('enqueues a whitelisted command and returns the worker result', async () => {
    const redis = makeRedis(
      { state: 'connected' },
      {
        ok: true,
        server_id: 'srv-1',
        request_id: 'req-1',
        command: 'AdminReloadServerConfig',
        response: 'Reloaded',
        completed_at: '2026-07-07T12:00:01.000Z',
        duration_ms: 12,
      },
    );

    const result = await sendRconCommandViaWorker(redis, {
      serverId: 'srv-1',
      command: 'AdminReloadServerConfig',
      requestId: 'req-1',
      timeoutMs: 5,
      pollIntervalMs: 0,
    });

    expect(redis.xadd).toHaveBeenCalledWith(
      'rcon:commands:srv-1',
      'MAXLEN',
      '~',
      '500',
      '*',
      'request',
      expect.stringContaining('"command":"AdminReloadServerConfig"'),
    );
    expect(result).toMatchObject({
      attempted: true,
      ok: true,
      requestId: 'req-1',
      response: 'Reloaded',
      via: 'worker-rcon',
    });
    expect(redis.del).toHaveBeenCalledWith('rcon:command-result:req-1');
  });

  it('times out after enqueue without suggesting a direct retry', async () => {
    const redis = makeRedis({ state: 'connected' });

    const result = await sendRconCommandViaWorker(redis, {
      serverId: 'srv-1',
      command: 'AdminEndMatch',
      requestId: 'req-1',
      timeoutMs: 1,
      pollIntervalMs: 0,
    });

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      attempted: true,
      ok: false,
      requestId: 'req-1',
      reason: 'timeout',
      via: 'worker-rcon',
    });
  });

  it('returns worker_rejected when the worker result payload is malformed', async () => {
    const redis = makeRedis({ state: 'connected' }, null);
    redis.get.mockImplementation((key: string) => {
      if (key === 'rcon:status:srv-1')
        return Promise.resolve(JSON.stringify({ state: 'connected' }));
      if (key === 'rcon:command-result:req-1') return Promise.resolve('{bad json');
      return Promise.resolve(null);
    });

    const result = await sendRconCommandViaWorker(redis, {
      serverId: 'srv-1',
      command: 'AdminEndMatch',
      requestId: 'req-1',
      timeoutMs: 5,
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      attempted: true,
      ok: false,
      requestId: 'req-1',
      reason: 'worker_rejected',
      via: 'worker-rcon',
    });
  });
});
