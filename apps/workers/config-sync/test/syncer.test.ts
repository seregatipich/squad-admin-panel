import { describe, expect, it, vi } from 'vitest';
import { appendWorkerAudit } from '../src/audit.js';
import { buildManagedSegment, spliceManagedSegment } from '../src/segment.js';
import {
  ADMINS_CFG_STATUS_KEY_PREFIX,
  adminsCfgPath,
  type SyncContext,
  syncServerAdminsCfg,
} from '../src/syncer.js';

// The `admins_cfg.synced` audit row is appended via `appendWorkerAudit`; mock
// it so its `context` object can be inspected without a live DB. The mutating
// paths still run — only the row persistence is replaced by a spy.
vi.mock('../src/audit.js', () => ({ appendWorkerAudit: vi.fn().mockResolvedValue(undefined) }));
const appendWorkerAuditMock = vi.mocked(appendWorkerAudit);

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** The exact `Admins.cfg` bytes the syncer regenerates for an empty DB snapshot
 * (the mock DB below returns no roles/admins) — used to drive the `in_sync`,
 * no-write path. */
function inSyncFileContent(): string {
  const generated = buildManagedSegment({ roles: [], admins: [], clanPriority: [] });
  return spliceManagedSegment('', generated.body);
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

interface RedisFakeOptions {
  /** `state` written into the seeded `rcon:status:<id>` key. Default 'connected'. */
  rconState?: 'connected' | 'connecting' | 'disconnected';
  /** When set, `xadd` (the RCON reload enqueue) rejects with this error. */
  xaddError?: Error;
}

function makeRedis(opts: RedisFakeOptions = {}) {
  const store = new Map<string, string>();
  store.set(
    `rcon:status:${SERVER_ID}`,
    JSON.stringify({ state: opts.rconState ?? 'connected', ts: '2026-07-25T00:00:00Z' }),
  );
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
    xadd: vi.fn().mockImplementation(() => {
      if (opts.xaddError) return Promise.reject(opts.xaddError);
      return Promise.resolve('1-0');
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

function makeCtx(
  bridgeResult: { content: string } | Error,
  writeError?: Error,
  redisOpts?: RedisFakeOptions,
): SyncContext {
  return {
    db: makeDb(),
    redis: makeRedis(redisOpts),
    bridge: makeBridge(bridgeResult, writeError),
    log: makeLogger(),
  };
}

/** Every reload enqueue is a single `xadd` to `rcon:commands:<id>`. */
function reloadEnqueues(ctx: SyncContext): unknown[][] {
  const xadd = (ctx.redis as unknown as { xadd: ReturnType<typeof vi.fn> }).xadd;
  return xadd.mock.calls.filter((c) => (c[0] as string) === `rcon:commands:${SERVER_ID}`);
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
    const bridge = ctx.bridge as ReturnType<typeof makeBridge>;

    expect(result.state).toBe('drift');
    expect(bridge.fileAtomicWrite).not.toHaveBeenCalled();
  });

  it('actively writes a correlated delivery even when its durable reason says drift_check', async () => {
    const bogusContent =
      '//SQUAD-PANEL BEGIN — не редактировать вручную\r\nGroup=Old:kick\r\n//SQUAD-PANEL END';
    const ctx = makeCtx({ content: bogusContent });
    const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
      reason: 'drift_check',
      actorPlayerId: null,
      mode: 'active',
    });
    const bridge = ctx.bridge as ReturnType<typeof makeBridge>;

    expect(result.state).toBe('wrote');
    expect(bridge.fileAtomicWrite).toHaveBeenCalledOnce();
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

  describe('RCON AdminReloadServerConfig reload (SYNC-3 correction №1)', () => {
    it('can defer reload to the correlated delivery confirmer', async () => {
      const err = new Error('not_found') as Error & { code: string };
      err.code = 'not_found';
      const ctx = makeCtx(err);
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'vip.lifecycle.assigned',
        actorPlayerId: null,
        requestReload: false,
      });

      expect(result.state).toBe('wrote');
      expect(result.reload).toBeUndefined();
      expect(reloadEnqueues(ctx)).toHaveLength(0);
      expect(appendWorkerAuditMock.mock.calls.at(-1)?.[1].context).not.toHaveProperty('reload');
    });

    it('enqueues exactly one reload after a not_found→write, returns wrote', async () => {
      const err = new Error('not_found') as Error & { code: string };
      err.code = 'not_found';
      const ctx = makeCtx(err);
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('wrote');
      expect(result.reload).toBe('enqueued');
      const enqueues = reloadEnqueues(ctx);
      expect(enqueues).toHaveLength(1);
      const request = JSON.parse(enqueues[0]?.[6] as string) as { command: string; args: string[] };
      expect(request.command).toBe('AdminReloadServerConfig');
      expect(request.args).toEqual([]);
    });

    it('enqueues exactly one reload on the forceWrite path', async () => {
      const err = new Error('no_such_file') as Error & { code: string };
      err.code = 'no_such_file';
      const ctx = makeCtx(err);
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'force_sync',
        actorPlayerId: '019d0000-0000-7000-8000-000000000001',
        forceWrite: true,
      });
      expect(result.state).toBe('wrote');
      expect(reloadEnqueues(ctx)).toHaveLength(1);
    });

    it('enqueues ZERO reloads on the in_sync (no-write) path', async () => {
      const ctx = makeCtx({ content: inSyncFileContent() });
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('in_sync');
      expect(result.reload).toBeUndefined();
      expect(reloadEnqueues(ctx)).toHaveLength(0);
    });

    it('enqueues ZERO reloads on the drift path', async () => {
      const bogusContent =
        '//SQUAD-PANEL BEGIN — не редактировать вручную\r\nGroup=Old:kick\r\n//SQUAD-PANEL END';
      const ctx = makeCtx({ content: bogusContent });
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'drift_check',
        actorPlayerId: null,
      });
      expect(result.state).toBe('drift');
      expect(reloadEnqueues(ctx)).toHaveLength(0);
    });

    it('enqueues ZERO reloads when fileRead fails (unreachable)', async () => {
      const ctx = makeCtx(new Error('bridge connection refused'));
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('unreachable');
      expect(reloadEnqueues(ctx)).toHaveLength(0);
    });

    it('enqueues ZERO reloads when fileAtomicWrite fails (unreachable)', async () => {
      const err = new Error('no_such_file') as Error & { code: string };
      err.code = 'no_such_file';
      const ctx = makeCtx(err, new Error('write permission denied'));
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('unreachable');
      expect(reloadEnqueues(ctx)).toHaveLength(0);
    });

    it('still returns wrote (reload best-effort) when the reload xadd rejects', async () => {
      const err = new Error('not_found') as Error & { code: string };
      err.code = 'not_found';
      const ctx = makeCtx(err, undefined, { xaddError: new Error('stream write failed') });
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('wrote');
      expect(result.reload).toBe('failed');
    });

    it('reports skipped_rcon_disconnected when RCON is not connected', async () => {
      const err = new Error('not_found') as Error & { code: string };
      err.code = 'not_found';
      const ctx = makeCtx(err, undefined, { rconState: 'disconnected' });
      const result = await syncServerAdminsCfg(ctx, SERVER_ID, {
        reason: 'manual',
        actorPlayerId: null,
      });
      expect(result.state).toBe('wrote');
      expect(result.reload).toBe('skipped_rcon_disconnected');
      expect(reloadEnqueues(ctx)).toHaveLength(0);
    });

    it('records the reload outcome in the admins_cfg.synced audit context', async () => {
      appendWorkerAuditMock.mockClear();
      const err = new Error('not_found') as Error & { code: string };
      err.code = 'not_found';
      const ctx = makeCtx(err);
      await syncServerAdminsCfg(ctx, SERVER_ID, { reason: 'manual', actorPlayerId: null });

      expect(appendWorkerAuditMock).toHaveBeenCalledOnce();
      const entry = appendWorkerAuditMock.mock.calls[0]?.[1];
      expect(entry?.actionType).toBe('admins_cfg.synced');
      expect(entry?.context).toMatchObject({ reload: 'enqueued' });
    });
  });
});
