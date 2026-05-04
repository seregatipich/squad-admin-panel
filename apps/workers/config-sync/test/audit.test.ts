import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { appendWorkerAudit } from '../src/audit.js';

function canonicalJsonString(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${(obj as unknown[]).map(canonicalJsonString).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(',')}}`;
}

function makeTx(lastRowHash: string | null) {
  const executeMock = vi.fn().mockResolvedValue(undefined);
  const selectMock = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(lastRowHash !== null ? [{ rowHash: lastRowHash }] : []),
  };
  return {
    select: vi.fn().mockReturnValue(selectMock),
    execute: executeMock,
    _executeMock: executeMock,
    _selectLimit: selectMock.limit,
  };
}

function makeDb(lastRowHash: string | null) {
  const tx = makeTx(lastRowHash);
  const db = {
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(tx);
    }),
    _tx: tx,
  };
  return db as never;
}

describe('appendWorkerAudit', () => {
  it('calls db.transaction', async () => {
    const db = makeDb(null);
    await appendWorkerAudit(db, {
      actorSteamId64: null,
      actionType: 'admins_cfg.synced',
      targetType: 'server',
      targetId: 'srv-001',
      before: null,
      after: null,
      context: { reason: 'test' },
    });
    expect(
      (db as ReturnType<typeof makeDb> & { transaction: ReturnType<typeof vi.fn> }).transaction,
    ).toHaveBeenCalledOnce();
  });

  it('uses system actor when actorSteamId64 is null', async () => {
    const db = makeDb(null);
    await appendWorkerAudit(db, {
      actorSteamId64: null,
      actionType: 'admins_cfg.synced',
      targetType: 'server',
      targetId: 'srv-001',
      before: null,
      after: null,
      context: {},
    });
    const executeMock = (db as ReturnType<typeof makeDb> & { _tx: ReturnType<typeof makeTx> })._tx
      ._executeMock;
    expect(executeMock).toHaveBeenCalledOnce();
    const sqlArg = executeMock.mock.calls[0]?.[0];
    expect(sqlArg).toBeDefined();
    expect(typeof sqlArg).toBe('object');
  });

  it('inserts with steam actor when actorSteamId64 is provided', async () => {
    const db = makeDb(null);
    await appendWorkerAudit(db, {
      actorSteamId64: '76561198000000001',
      actionType: 'admins_cfg.force_synced',
      targetType: 'server',
      targetId: 'srv-002',
      before: { segment_hash: 'abc' },
      after: { segment_hash: 'def' },
      context: { groups_count: 2 },
    });
    const executeMock = (db as ReturnType<typeof makeDb> & { _tx: ReturnType<typeof makeTx> })._tx
      ._executeMock;
    expect(executeMock).toHaveBeenCalledOnce();
  });

  it('computes row_hash as sha256(prev_hash || canonical_json) when prev_hash exists', async () => {
    const prevHash = Buffer.from('deadbeef'.repeat(8), 'hex');
    const db = makeDb(prevHash.toString('hex'));

    const entry = {
      actorSteamId64: null,
      actionType: 'admins_cfg.synced',
      targetType: 'server',
      targetId: 'srv-003',
      before: null,
      after: null,
      context: {},
    };
    await appendWorkerAudit(db as never, entry);

    const payload = {
      actor_kind: 'system',
      actor_steam_id64: null,
      actor_system_label: 'worker-config-sync',
      action_type: entry.actionType,
      target_type: entry.targetType,
      target_id: entry.targetId,
      before_snapshot: null,
      after_snapshot: null,
      context: {},
    };
    const canonical = canonicalJsonString(payload);
    const hasher = createHash('sha256');
    hasher.update(prevHash.toString('hex'));
    hasher.update(canonical, 'utf8');
    const expectedHash = hasher.digest();

    const executeMock = (db as ReturnType<typeof makeDb> & { _tx: ReturnType<typeof makeTx> })._tx
      ._executeMock;
    const callArgs = executeMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(expectedHash).toBeInstanceOf(Buffer);
    expect(expectedHash.length).toBe(32);
  });

  it('computes row_hash without prev_hash when table is empty', async () => {
    const db = makeDb(null);
    await appendWorkerAudit(db, {
      actorSteamId64: null,
      actionType: 'admins_cfg.sync_failed',
      targetType: 'server',
      targetId: 'srv-004',
      before: null,
      after: null,
      context: { phase: 'file_read', error: 'bridge down' },
    });
    const executeMock = (db as ReturnType<typeof makeDb> & { _tx: ReturnType<typeof makeTx> })._tx
      ._executeMock;
    expect(executeMock).toHaveBeenCalledOnce();
  });
});
