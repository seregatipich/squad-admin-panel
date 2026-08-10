import { rconCommandStream } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { requestAdminsCfgReload } from '../src/rcon-reload.js';

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
