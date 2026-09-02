import { describe, expect, it, vi } from 'vitest';
import { type AdminsCfgDeliveryOperations, handleAdminsCfgSyncEntry } from '../src/delivery.js';

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OUTBOX_ID = '019d0000-0000-7000-8000-000000000123';
const STREAM = `events:admins-cfg-sync:${SERVER_ID}`;
const STREAM_ID = '1-0';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function setup(statuses: Array<string | null> = ['running', 'running']) {
  let row = {
    id: OUTBOX_ID,
    serverId: SERVER_ID,
    payload: {
      reason: 'vip.lifecycle.assigned',
      actor_player_id: null,
    } as unknown,
    correlationId: 'evt-1' as string | null,
    appliedAt: null as Date | null,
    reloadOutcome: null as string | null,
    lastError: null as string | null,
  };
  const redis = {
    eval: vi.fn().mockResolvedValue([1, 1]),
    xack: vi.fn().mockResolvedValue(1),
  };
  const sync = vi.fn().mockResolvedValue({
    state: 'in_sync',
    serverId: SERVER_ID,
    expectedHash: 'hash',
    actualHash: 'hash',
    groupsCount: 0,
    adminsCount: 0,
  });
  const confirmReload = vi.fn().mockResolvedValue('confirmed');
  const readServerState = vi.fn().mockImplementation(async () => {
    const status = statuses.shift() ?? null;
    return status ? { status, deletedAt: null } : null;
  });
  const operations: AdminsCfgDeliveryOperations = {
    getOutbox: vi.fn().mockImplementation(async () => row),
    isSuperseded: vi.fn().mockResolvedValue(false),
    markApplied: vi.fn().mockImplementation(async (_db, _id, outcome) => {
      row = { ...row, appliedAt: new Date(), reloadOutcome: outcome, lastError: null };
      return row;
    }),
    markFailed: vi.fn().mockImplementation(async (_db, _id, code) => {
      row = { ...row, reloadOutcome: code, lastError: code };
      return row;
    }),
    readServerState,
    sync,
    confirmReload,
  };
  const ctx = {
    db: {} as never,
    redis: redis as never,
    bridge: {} as never,
    log: logger(),
  };
  const entry = {
    serverId: SERVER_ID,
    streamName: STREAM,
    streamId: STREAM_ID,
    event: {
      reason: 'vip.lifecycle.assigned',
      actor_player_id: null,
      _outbox_id: OUTBOX_ID,
    },
  };
  return { ctx, entry, operations, redis, sync, confirmReload, readServerState, row: () => row };
}

describe('correlated Admins.cfg delivery', () => {
  it('requires exact RCON confirmation for a live server after two fresh state reads', async () => {
    const t = setup(['running', 'running']);

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');

    expect(t.sync).toHaveBeenCalledWith(t.ctx, SERVER_ID, {
      reason: 'vip.lifecycle.assigned',
      actorPlayerId: null,
      forceWrite: false,
      mode: 'active',
      requestReload: false,
    });
    expect(t.readServerState).toHaveBeenCalledTimes(2);
    expect(t.confirmReload).toHaveBeenCalledWith(t.ctx.redis, SERVER_ID, OUTBOX_ID, t.ctx.log);
    expect(t.row()).toMatchObject({ appliedAt: expect.any(Date), reloadOutcome: 'confirmed' });
    expect(t.redis.eval).toHaveBeenCalledOnce();
    expect(vi.mocked(t.operations.markApplied).mock.invocationCallOrder[0]).toBeLessThan(
      t.redis.eval.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('uses confirmed delivery for a non-VIP outbox row too', async () => {
    const t = setup(['running', 'running']);
    t.row().correlationId = null;
    const entry = { ...t.entry, event: { ...t.entry.event, reason: 'role.update' } };

    await handleAdminsCfgSyncEntry(t.ctx, entry, t.operations);

    expect(t.confirmReload).toHaveBeenCalledOnce();
    expect(t.row().reloadOutcome).toBe('confirmed');
  });

  it('uses only the durable payload and explicitly requests active sync', async () => {
    const t = setup(['stopped', 'stopped']);
    t.row().payload = {
      reason: 'force_sync',
      actor_player_id: 'durable-actor',
      forceWrite: true,
    };
    const entry = {
      ...t.entry,
      event: {
        ...t.entry.event,
        reason: 'drift_check',
        actor_player_id: 'untrusted-envelope-actor',
        forceWrite: false,
      },
    };

    await handleAdminsCfgSyncEntry(t.ctx, entry, t.operations);

    expect(t.sync).toHaveBeenCalledWith(t.ctx, SERVER_ID, {
      reason: 'force_sync',
      actorPlayerId: 'durable-actor',
      forceWrite: true,
      mode: 'active',
      requestReload: false,
    });
  });

  it('does not trust a stopped first read when the server becomes running', async () => {
    const t = setup(['stopped', 'running', 'running']);

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.confirmReload).toHaveBeenCalledOnce();
    expect(t.readServerState).toHaveBeenCalledTimes(3);
    expect(t.row().reloadOutcome).toBe('confirmed');
  });

  it('records file_ready_for_restart when a live server becomes stopped', async () => {
    const t = setup(['running', 'stopped']);

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.confirmReload).toHaveBeenCalledOnce();
    expect(t.row().reloadOutcome).toBe('file_ready_for_restart');
  });

  it('records file_ready_for_restart after two stable nonlive reads without RCON', async () => {
    const t = setup(['stopped', 'stopped']);

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.confirmReload).not.toHaveBeenCalled();
    expect(t.row().reloadOutcome).toBe('file_ready_for_restart');
  });

  it('keeps failed confirmation pending and never ACKs or deletes it', async () => {
    const t = setup(['starting']);
    t.confirmReload.mockResolvedValueOnce('timeout');

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('retry');

    expect(t.row()).toMatchObject({ appliedAt: null, lastError: 'timeout' });
    expect(t.redis.eval).not.toHaveBeenCalled();
  });

  it('reclaims a crash after file sync but before an RCON result with the same outbox id', async () => {
    const t = setup(['starting', 'starting', 'starting']);
    t.confirmReload.mockResolvedValueOnce('timeout').mockResolvedValueOnce('confirmed');

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('retry');
    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');

    expect(t.sync).toHaveBeenCalledTimes(2);
    expect(t.confirmReload).toHaveBeenNthCalledWith(
      1,
      t.ctx.redis,
      SERVER_ID,
      OUTBOX_ID,
      t.ctx.log,
    );
    expect(t.confirmReload).toHaveBeenNthCalledWith(
      2,
      t.ctx.redis,
      SERVER_ID,
      OUTBOX_ID,
      t.ctx.log,
    );
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('reclaims a crash after the RCON result but before applied_at', async () => {
    const t = setup(['running', 'running', 'running', 'running']);
    vi.mocked(t.operations.markApplied).mockRejectedValueOnce(new Error('process crashed'));

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).rejects.toThrow(
      'process crashed',
    );
    expect(t.row().appliedAt).toBeNull();
    expect(t.redis.eval).not.toHaveBeenCalled();

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');
    expect(t.sync).toHaveBeenCalledTimes(2);
    expect(t.confirmReload).toHaveBeenCalledTimes(2);
    expect(t.row().appliedAt).toBeInstanceOf(Date);
  });

  it('finishes an already applied replay without touching file or RCON', async () => {
    const t = setup();
    await t.operations.markApplied(t.ctx.db, OUTBOX_ID, 'confirmed');

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.sync).not.toHaveBeenCalled();
    expect(t.confirmReload).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('treats a deleted server as terminal success', async () => {
    const t = setup([null]);

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.confirmReload).not.toHaveBeenCalled();
    expect(t.row().reloadOutcome).toBe('server_removed');
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('ACKs and deletes a durable superseded event without touching file or RCON', async () => {
    const t = setup();
    vi.mocked(t.operations.isSuperseded).mockResolvedValueOnce(true);

    await handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations);

    expect(t.sync).not.toHaveBeenCalled();
    expect(t.confirmReload).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('recovers an XDEL-stage failure by replaying only terminal cleanup', async () => {
    const t = setup();
    t.redis.eval.mockRejectedValueOnce(new Error('xdel failed'));

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).rejects.toThrow(
      'xdel failed',
    );
    expect(t.row().appliedAt).toBeInstanceOf(Date);

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');
    expect(t.sync).toHaveBeenCalledOnce();
    expect(t.confirmReload).toHaveBeenCalledOnce();
    expect(t.redis.eval).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy sync behavior and removes the successful stream tail', async () => {
    const t = setup();
    const legacyEntry = { ...t.entry, event: { reason: 'role.update', actor_player_id: null } };

    await handleAdminsCfgSyncEntry(t.ctx, legacyEntry, t.operations);

    expect(t.sync).toHaveBeenCalledWith(t.ctx, SERVER_ID, {
      reason: 'role.update',
      actorPlayerId: null,
      forceWrite: false,
    });
    expect(t.redis.xack).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('removes a malformed outbox link without touching DB, file, or RCON', async () => {
    const t = setup();
    const malformed = { ...t.entry, event: { ...t.entry.event, _outbox_id: 'not-a-uuid' } };

    await expect(handleAdminsCfgSyncEntry(t.ctx, malformed, t.operations)).resolves.toBe(
      'completed',
    );

    expect(t.operations.getOutbox).not.toHaveBeenCalled();
    expect(t.sync).not.toHaveBeenCalled();
    expect(t.confirmReload).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('removes a missing durable link after the DB read succeeds', async () => {
    const t = setup();
    vi.mocked(t.operations.getOutbox).mockResolvedValueOnce(null);

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');

    expect(t.sync).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('removes a mismatched durable link after the DB read succeeds', async () => {
    const t = setup();
    vi.mocked(t.operations.getOutbox).mockResolvedValueOnce({
      ...t.row(),
      serverId: '11111111-2222-3333-4444-555555555555',
    } as never);

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).resolves.toBe('completed');

    expect(t.sync).not.toHaveBeenCalled();
    expect(t.redis.eval).toHaveBeenCalledOnce();
  });

  it('leaves the entry pending when the durable DB read fails temporarily', async () => {
    const t = setup();
    vi.mocked(t.operations.getOutbox).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(handleAdminsCfgSyncEntry(t.ctx, t.entry, t.operations)).rejects.toThrow(
      'database unavailable',
    );

    expect(t.sync).not.toHaveBeenCalled();
    expect(t.redis.eval).not.toHaveBeenCalled();
  });

  it.each([null, 'not-an-object', 7, []])(
    'removes malformed JSON value %j without DB, file, or RCON work',
    async (event) => {
      const t = setup();
      const malformed = { ...t.entry, event: event as never };

      await expect(handleAdminsCfgSyncEntry(t.ctx, malformed, t.operations)).resolves.toBe(
        'completed',
      );

      expect(t.operations.getOutbox).not.toHaveBeenCalled();
      expect(t.sync).not.toHaveBeenCalled();
      expect(t.confirmReload).not.toHaveBeenCalled();
      expect(t.redis.eval).toHaveBeenCalledOnce();
    },
  );
});
