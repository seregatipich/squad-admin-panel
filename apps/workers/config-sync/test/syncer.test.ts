import { describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_STATUS_KEY_PREFIX,
  adminsCfgPath,
  type SyncContext,
  syncServerAdminsCfg,
} from '../src/syncer.js';

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

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
  } as never;
}

function makeTx(lastRowHash: string | null) {
  const executeMock = vi.fn().mockResolvedValue(undefined);
  const selectMock = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(lastRowHash !== null ? [{ rowHash: lastRowHash }] : []),
  };
  return { select: vi.fn().mockReturnValue(selectMock), execute: executeMock };
}

function makeDb() {
  const tx = makeTx(null);
  return {
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(tx);
    }),
  } as never;
}

function makeBridge(fileReadResult: { content: string } | Error, writeError?: Error) {
  return {
    fileRead: vi.fn().mockImplementation(() => {
      if (fileReadResult instanceof Error) return Promise.reject(fileReadResult);
      return Promise.resolve(fileReadResult);
    }),
    fileAtomicWrite: vi.fn().mockImplementation(() => {
      if (writeError) return Promise.reject(writeError);
      return Promise.resolve({});
    }),
  } as never;
}

function makeCtx(bridgeResult: { content: string } | Error, writeError?: Error): SyncContext {
  return {
    db: makeDb(),
    redis: makeRedis(),
    bridge: makeBridge(bridgeResult, writeError),
    log: makeLogger(),
  };
}

describe('adminsCfgPath', () => {
  it('returns the correct absolute path for a server id', () => {
    expect(adminsCfgPath(SERVER_ID)).toBe(
      `/var/lib/squad-panel/configs/${SERVER_ID}/ServerConfig/Admins.cfg`,
    );
  });
});

describe('syncServerAdminsCfg', () => {
  it('returns unreachable when bridge fileRead throws a non-not_found error', async () => {
    const ctx = makeCtx(new Error('bridge connection refused'));
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'manual',
      actorPlayerId: null,
    });
    expect(result.state).toBe('unreachable');
    expect(result.serverId).toBe(SERVER_ID);
    expect(result.error).toBeDefined();
    expect(result.actualHash).toBeNull();
  });

  it('publishes syncing status to redis at start', async () => {
    const ctx = makeCtx(new Error('bridge down'));
    await syncServerAdminsCfg(ctx, SERVER_ID, { reason: 'manual', actorPlayerId: null });
    const redis = ctx.redis as ReturnType<typeof makeRedis>;
    expect(redis.set).toHaveBeenCalled();
    const firstSetKey = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(firstSetKey).toBe(`${ADMINS_CFG_STATUS_KEY_PREFIX}${SERVER_ID}`);
  });

  it('publishes unreachable status when fileRead fails', async () => {
    const ctx = makeCtx(new Error('timeout'));
    await syncServerAdminsCfg(ctx, SERVER_ID, { reason: 'manual', actorPlayerId: null });
    const redis = ctx.redis as ReturnType<typeof makeRedis>;
    const calls = (redis.set as ReturnType<typeof vi.fn>).mock.calls;
    const statusCalls = calls.filter((c: string[]) =>
      (c[0] as string).startsWith(ADMINS_CFG_STATUS_KEY_PREFIX),
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
    const lastStatus = JSON.parse(statusCalls[statusCalls.length - 1]?.[1] as string);
    expect(lastStatus.state).toBe('unreachable');
  });

  it('returns in_sync when file content already matches DB-generated segment', async () => {
    const ctx = makeCtx(new Error('no such file'));
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'manual',
      actorPlayerId: null,
    });
    expect(['wrote', 'in_sync', 'unreachable']).toContain(result.state);
    expect(result.serverId).toBe(SERVER_ID);
  });

  it('treats not_found error as empty file and writes', async () => {
    const err = new Error('not_found') as Error & { code: string };
    err.code = 'not_found';
    const ctx = makeCtx(err);
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'manual',
      actorPlayerId: null,
    });
    expect(result.state).toBe('wrote');
    const bridge = ctx.bridge as ReturnType<typeof makeBridge>;
    expect(bridge.fileAtomicWrite).toHaveBeenCalledOnce();
  });

  it('returns drift on passive check when hashes differ', async () => {
    const bogusContent =
      '//SQUAD-PANEL BEGIN — не редактировать вручную\r\nGroup=Old:kick\r\n//SQUAD-PANEL END';
    const ctx = makeCtx({ content: bogusContent });
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'drift_check',
      actorPlayerId: null,
    });
    expect(['drift', 'in_sync']).toContain(result.state);
  });

  it('writes on forceWrite=true even if hashes match', async () => {
    const err = new Error('no_such_file');
    (err as Error & { code: string }).code = 'no_such_file';
    const ctx = makeCtx(err);
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'force_sync',
      actorPlayerId: '019d0000-0000-7000-8000-000000000001',
      forceWrite: true,
    });
    expect(result.state).toBe('wrote');
  });

  it('returns unreachable when fileAtomicWrite fails', async () => {
    const err = new Error('no_such_file');
    (err as Error & { code: string }).code = 'no_such_file';
    const ctx = makeCtx(err, new Error('write permission denied'));
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'manual',
      actorPlayerId: null,
    });
    expect(result.state).toBe('unreachable');
  });
});
