import { describe, expect, it, vi } from 'vitest';
import { buildClanPriorityExpiryAuditEntry, runClanPriorityExpiryTick } from '../src/tick.js';

describe('runClanPriorityExpiryTick', () => {
  it('is a no-op when there are no expired unprocessed clans', async () => {
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue([]),
      expireClans: vi.fn(async (candidates: unknown[]) => ({ expired: candidates, enqueued: 0 })),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 0, enqueued: 0 });
    expect(deps.expireClans).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_ok', severity: 'info' }),
    );
  });

  it('expires the found clans in one call and reports what that call expired', async () => {
    const now = new Date('2026-07-14T10:00:00.000Z');
    const expired = [
      {
        clanId: '019e0000-0000-7000-8000-000000000301',
        clanName: 'Альфа',
        priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
      },
      {
        clanId: '019e0000-0000-7000-8000-000000000302',
        clanName: 'Бета',
        priorityExpiresAt: new Date('2026-07-14T08:00:00.000Z'),
      },
    ];
    const deps = {
      now,
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue(expired),
      expireClans: vi.fn(async (candidates: unknown[]) => ({ expired: candidates, enqueued: 3 })),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 2, enqueued: 3 });
    expect(deps.findExpiredUnprocessedClans).toHaveBeenCalledWith(now);
    expect(deps.expireClans).toHaveBeenCalledWith(
      expired,
      now,
      expect.objectContaining({ reason: 'clan.priority.expire', actor_player_id: null }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_ok', severity: 'info' }),
    );
  });

  it('does not re-fire for an already-processed clan (findExpiredUnprocessedClans excludes it)', async () => {
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue([]),
      expireClans: vi.fn(async (candidates: unknown[]) => ({ expired: candidates, enqueued: 0 })),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 0, enqueued: 0 });
    expect(deps.expireClans).not.toHaveBeenCalled();
  });

  it('never touches clan_members.has_priority (no such dependency exists on the interface)', async () => {
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue([
        {
          clanId: '019e0000-0000-7000-8000-000000000303',
          clanName: 'Гамма',
          priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
        },
      ]),
      expireClans: vi.fn(async (candidates: unknown[]) => ({ expired: candidates, enqueued: 1 })),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };
    expect(Object.keys(deps)).not.toContain('clearHasPriority');
    expect(Object.keys(deps)).not.toContain('updateClanMembers');

    await runClanPriorityExpiryTick(deps);
    expect(deps.expireClans).toHaveBeenCalledTimes(1);
  });

  it('emits run_failed and rethrows when findExpiredUnprocessedClans throws', async () => {
    const boom = new Error('db unreachable');
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockRejectedValue(boom),
      expireClans: vi.fn(async (candidates: unknown[]) => ({ expired: candidates, enqueued: 0 })),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runClanPriorityExpiryTick(deps)).rejects.toThrow('db unreachable');
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_failed', severity: 'error' }),
    );
  });

  it('reports only the clans the transaction actually expired (#865)', async () => {
    const candidates = [
      {
        clanId: '019e0000-0000-7000-8000-000000000304',
        clanName: 'Дельта',
        priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
      },
      {
        clanId: '019e0000-0000-7000-8000-000000000305',
        clanName: 'Эпсилон',
        priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
      },
    ];
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue(candidates),
      expireClans: vi.fn().mockResolvedValue({ expired: [candidates[1]], enqueued: 2 }),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 1, enqueued: 2 });
  });
});

describe('buildClanPriorityExpiryAuditEntry', () => {
  it('records the system actor and the before/after of the processed flag', () => {
    const now = new Date('2026-07-14T10:00:00.000Z');
    const clan = {
      clanId: '019e0000-0000-7000-8000-000000000301',
      clanName: 'Альфа',
      priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
    };

    expect(buildClanPriorityExpiryAuditEntry(clan, now)).toEqual({
      actor: { kind: 'system', label: 'clan-priority-expirer' },
      actorIp: null,
      actionType: 'clan.priority.expire',
      targetType: 'clan',
      targetId: clan.clanId,
      before: { priority_expires_at: '2026-07-14T09:00:00.000Z', priority_expiry_processed: false },
      after: { priority_expiry_processed: true },
      context: { clan_name: 'Альфа', expired_at: '2026-07-14T10:00:00.000Z' },
      statusCode: 200,
    });
  });
});
