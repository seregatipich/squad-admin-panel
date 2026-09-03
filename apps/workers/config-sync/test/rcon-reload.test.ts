import { rconCommandResultKey, rconCommandStream } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import {
  type ConfirmAdminsCfgReloadOptions,
  confirmAdminsCfgReload,
  requestAdminsCfgReload,
} from '../src/rcon-reload.js';

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

/**
 * Minimal fake of the two Redis methods the reload helper touches: `get`
 * (returns the raw `rcon:status:<id>` payload the test seeds) and `xadd`.
 */
function makeRedis(statusRaw: string | null, xaddError?: Error) {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      expect(key).toBe(`rcon:status:${SERVER_ID}`);
      return Promise.resolve(statusRaw);
    }),
    xadd: vi.fn().mockImplementation(() => {
      if (xaddError) return Promise.reject(xaddError);
      return Promise.resolve('1-0');
    }),
  };
}

describe('requestAdminsCfgReload', () => {
  it('enqueues exactly one AdminReloadServerConfig when RCON is connected', async () => {
    const redis = makeRedis(JSON.stringify({ state: 'connected', ts: '2026-07-25T00:00:00Z' }));
    const log = makeLogger();

    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, log);

    expect(outcome).toBe('enqueued');
    expect(redis.xadd).toHaveBeenCalledOnce();
    const args = redis.xadd.mock.calls[0] as string[];
    expect(args[0]).toBe(rconCommandStream(SERVER_ID));
    expect(args[0]).toBe(`rcon:commands:${SERVER_ID}`);
    // …MAXLEN ~ 500 * request <json>
    expect(args.slice(1, 6)).toEqual(['MAXLEN', '~', '500', '*', 'request']);
    const request = JSON.parse(args[6] as string) as { command: string; args: string[] };
    expect(request.command).toBe('AdminReloadServerConfig');
    expect(request.args).toEqual([]);
  });

  it('skips (no xadd) when the rcon:status key is absent', async () => {
    const redis = makeRedis(null);
    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, makeLogger());
    expect(outcome).toBe('skipped_rcon_disconnected');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('skips (no xadd) when RCON is still connecting', async () => {
    const redis = makeRedis(JSON.stringify({ state: 'connecting' }));
    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, makeLogger());
    expect(outcome).toBe('skipped_rcon_disconnected');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('skips (no xadd) when RCON is disconnected', async () => {
    const redis = makeRedis(JSON.stringify({ state: 'disconnected' }));
    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, makeLogger());
    expect(outcome).toBe('skipped_rcon_disconnected');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('skips (no xadd, no throw) when the status payload is malformed JSON', async () => {
    const redis = makeRedis('{not-valid-json');
    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, makeLogger());
    expect(outcome).toBe('skipped_rcon_disconnected');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('returns failed (no throw, warns) when the xadd rejects', async () => {
    const redis = makeRedis(
      JSON.stringify({ state: 'connected' }),
      new Error('redis stream write failed'),
    );
    const log = makeLogger();

    const outcome = await requestAdminsCfgReload(redis as never, SERVER_ID, log);

    expect(outcome).toBe('failed');
    expect(redis.xadd).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('confirmAdminsCfgReload', () => {
  const OUTBOX_ID = '019d0000-0000-7000-8000-000000000123';
  const OLD_REQUEST_ID = `admins-cfg-sync:${OUTBOX_ID}`;
  const ATTEMPT_ID = '019d0000-0000-7000-8000-000000000456';
  const REQUEST_ID = `${OLD_REQUEST_ID}:${ATTEMPT_ID}`;
  const options = (overrides: ConfirmAdminsCfgReloadOptions = {}) => ({
    attemptId: ATTEMPT_ID,
    ...overrides,
  });

  function result(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      ok: true,
      server_id: SERVER_ID,
      request_id: REQUEST_ID,
      command: 'AdminReloadServerConfig',
      response: 'Configuration reloaded',
      completed_at: '2026-09-03T10:00:00.000Z',
      duration_ms: 12,
      ...overrides,
    });
  }

  function redisWithResults(...values: Array<string | null>) {
    return {
      get: vi.fn().mockImplementation(() => Promise.resolve(values.shift() ?? null)),
      xadd: vi.fn().mockResolvedValue('1-0'),
    };
  }

  it('uses an attempt-bound request id and accepts only the exact valid result', async () => {
    const redis = redisWithResults(null, result());

    await expect(
      confirmAdminsCfgReload(
        redis as never,
        SERVER_ID,
        OUTBOX_ID,
        makeLogger(),
        options({
          timeoutMs: 20,
          pollIntervalMs: 1,
        }),
      ),
    ).resolves.toBe('confirmed');

    expect(redis.get).toHaveBeenCalledWith(rconCommandResultKey(REQUEST_ID));
    const args = redis.xadd.mock.calls[0] as string[];
    expect(args[0]).toBe(rconCommandStream(SERVER_ID));
    const request = JSON.parse(args[6] as string) as { request_id: string };
    expect(request.request_id).toBe(REQUEST_ID);
  });

  it.each([
    ['request id', { request_id: 'another-request' }],
    ['server id', { server_id: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb' }],
    ['command', { command: 'AdminEndMatch' }],
    ['schema', { duration_ms: -1 }],
  ])('rejects a mismatched %s result', async (_label, overrides) => {
    const redis = redisWithResults(null, result(overrides));
    await expect(
      confirmAdminsCfgReload(
        redis as never,
        SERVER_ID,
        OUTBOX_ID,
        makeLogger(),
        options({
          timeoutMs: 20,
          pollIntervalMs: 1,
        }),
      ),
    ).resolves.toBe('invalid_result');
  });

  it('maps ok=false to rejected without exposing the raw error', async () => {
    const redis = redisWithResults(null, result({ ok: false, error: 'secret output' }));
    await expect(
      confirmAdminsCfgReload(
        redis as never,
        SERVER_ID,
        OUTBOX_ID,
        makeLogger(),
        options({
          timeoutMs: 20,
          pollIntervalMs: 1,
        }),
      ),
    ).resolves.toBe('rejected');
  });

  it('returns timeout while keeping the deterministic command retryable', async () => {
    const redis = redisWithResults(null, null, null, null);
    await expect(
      confirmAdminsCfgReload(
        redis as never,
        SERVER_ID,
        OUTBOX_ID,
        makeLogger(),
        options({
          timeoutMs: 2,
          pollIntervalMs: 1,
        }),
      ),
    ).resolves.toBe('timeout');
    expect(redis.xadd).toHaveBeenCalledOnce();
  });

  it('enqueues this attempt before accepting its exact result', async () => {
    const redis = redisWithResults(result());
    await expect(
      confirmAdminsCfgReload(redis as never, SERVER_ID, OUTBOX_ID, makeLogger(), options()),
    ).resolves.toBe('confirmed');
    expect(redis.xadd).toHaveBeenCalledOnce();
  });

  it('ignores a cached result from an earlier delivery attempt and confirms a fresh reload', async () => {
    let freshRequestId: string | null = null;
    const oldResultKey = rconCommandResultKey(OLD_REQUEST_ID);
    const redis = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === oldResultKey) return result({ request_id: OLD_REQUEST_ID });
        if (freshRequestId && key === rconCommandResultKey(freshRequestId)) {
          return result({ request_id: freshRequestId });
        }
        return null;
      }),
      xadd: vi.fn().mockImplementation(async (...args: string[]) => {
        freshRequestId = (JSON.parse(args[6] ?? '{}') as { request_id: string }).request_id;
        return '1-0';
      }),
    };

    await expect(
      confirmAdminsCfgReload(redis as never, SERVER_ID, OUTBOX_ID, makeLogger(), {
        timeoutMs: 20,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe('confirmed');

    expect(redis.xadd).toHaveBeenCalledOnce();
    expect(freshRequestId).not.toBe(OLD_REQUEST_ID);
    expect(freshRequestId).toMatch(new RegExp(`^${OLD_REQUEST_ID}:`));
    expect(redis.get).not.toHaveBeenCalledWith(oldResultKey);
  });

  it('maps enqueue failure to unavailable', async () => {
    const redis = redisWithResults(null);
    redis.xadd.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      confirmAdminsCfgReload(redis as never, SERVER_ID, OUTBOX_ID, makeLogger(), options()),
    ).resolves.toBe('unavailable');
  });
});
