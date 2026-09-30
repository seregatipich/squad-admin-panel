import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { MANUAL_GROUP, MANUAL_STREAM, runManualQueueLoop } from '../src/manual-queue.js';
import type { SyncReport } from '../src/sync-source.js';
import type { DueSource } from '../src/tick.js';

const silentLog = pino({ enabled: false });

const OK_REPORT: SyncReport = {
  ok: true,
  added: 1,
  updated: 0,
  revoked: 0,
  skipped: 0,
  durationMs: 1,
  bytes: 1,
};

function source(id: string): DueSource {
  return {
    id,
    name: 'RuBans',
    url: 'https://example.com/bans.cfg',
    format: 'squad_bans_cfg',
    authHeaderEncrypted: null,
    parserConfig: {},
    consecutiveFailures: 0,
    lastSyncAt: null,
    pollIntervalMinutes: 15,
  };
}

function job(sourceId: string): string[] {
  return ['job', JSON.stringify({ source_id: sourceId })];
}

/** Serves `reads` one element per XREADGROUP call (an `Error` is thrown), then empty reads. */
function fakeRedis(reads: Array<Array<[string, string[]]> | Error>) {
  const queue = [...reads];
  return {
    xgroup: vi.fn(async (..._args: unknown[]) => 'OK'),
    xack: vi.fn(async (..._args: unknown[]) => 1),
    xreadgroup: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ? [[MANUAL_STREAM, next]] : null;
    }),
  };
}

function deps(redis: ReturnType<typeof fakeRedis>, iterations: number) {
  let checks = 0;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fake exposes only the commands the loop calls
    redis: redis as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake exposes only the commands the loop calls
    readRedis: redis as any,
    consumer: 'test',
    blockMs: 1,
    loadSource: vi.fn(async (id: string) => source(id)),
    syncOne: vi.fn(async () => OK_REPORT),
    inFlight: new Set<string>(),
    log: silentLog,
    shouldStop: () => checks++ >= iterations,
    sleep: async () => undefined,
  };
}

describe('runManualQueueLoop', () => {
  it('syncs the requested source and acks the job', async () => {
    const redis = fakeRedis([[['1-0', job('s1')]]]);
    const d = deps(redis, 1);
    const onSynced = vi.fn();

    await runManualQueueLoop({ ...d, onSynced });

    expect(d.syncOne).toHaveBeenCalledWith(source('s1'));
    expect(onSynced).toHaveBeenCalledWith(source('s1'), OK_REPORT);
    expect(redis.xack).toHaveBeenCalledWith(MANUAL_STREAM, MANUAL_GROUP, '1-0');
  });

  it('skips a source the scheduled tick is already syncing (#853)', async () => {
    const redis = fakeRedis([[['1-0', job('s1')]]]);
    const d = deps(redis, 1);
    d.inFlight.add('s1');

    await runManualQueueLoop(d);

    expect(d.syncOne).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith(MANUAL_STREAM, MANUAL_GROUP, '1-0');
    expect(d.inFlight.has('s1')).toBe(true);
  });

  it('keeps consuming after an XACK fails (#1292)', async () => {
    const redis = fakeRedis([[['1-0', job('s1')]], [['2-0', job('s2')]]]);
    redis.xack.mockRejectedValueOnce(
      new Error("READONLY You can't write against a read only replica."),
    );
    const d = deps(redis, 2);

    await expect(runManualQueueLoop(d)).resolves.toBeUndefined();

    expect(d.syncOne).toHaveBeenCalledTimes(2);
    expect(redis.xack).toHaveBeenLastCalledWith(MANUAL_STREAM, MANUAL_GROUP, '2-0');
  });

  it('acks a job whose source lookup fails and moves on', async () => {
    const redis = fakeRedis([[['1-0', job('s1')]]]);
    const d = deps(redis, 1);
    d.loadSource.mockRejectedValueOnce(new Error('db down'));

    await runManualQueueLoop(d);

    expect(redis.xack).toHaveBeenCalledWith(MANUAL_STREAM, MANUAL_GROUP, '1-0');
  });

  it('acks malformed jobs and jobs for unknown sources without syncing', async () => {
    const redis = fakeRedis([
      [
        ['1-0', ['other', 'x']],
        ['2-0', ['job', '{not json']],
        ['3-0', ['job', '{}']],
        ['4-0', job('gone')],
      ],
    ]);
    const d = deps(redis, 1);
    d.loadSource.mockResolvedValueOnce(null);

    await runManualQueueLoop(d);

    expect(d.syncOne).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledTimes(4);
  });

  it('retries group creation and re-creates the group after NOGROUP (#1292)', async () => {
    const redis = fakeRedis([new Error('NOGROUP No such key'), []]);
    redis.xgroup.mockRejectedValueOnce(new Error('LOADING Redis is loading the dataset'));
    const d = deps(redis, 4);

    await expect(runManualQueueLoop(d)).resolves.toBeUndefined();

    expect(redis.xgroup).toHaveBeenCalledTimes(3);
    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      MANUAL_STREAM,
      MANUAL_GROUP,
      '$',
      'MKSTREAM',
    );
  });

  it('returns when shutdown closes the connection under the blocked read', async () => {
    const redis = fakeRedis([new Error('Connection is closed.')]);
    let stopped = false;
    redis.xreadgroup.mockImplementationOnce(async () => {
      stopped = true;
      throw new Error('Connection is closed.');
    });

    await runManualQueueLoop({ ...deps(redis, 10), shouldStop: () => stopped });

    expect(redis.xreadgroup).toHaveBeenCalledOnce();
  });
});
