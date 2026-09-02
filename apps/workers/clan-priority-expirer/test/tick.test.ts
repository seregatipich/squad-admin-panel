import { describe, expect, it, vi } from 'vitest';
import { runClanPriorityExpiryTick } from '../src/tick.js';

describe('runClanPriorityExpiryTick', () => {
  it('is a no-op when there are no expired unprocessed clans', async () => {
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue([]),
      markProcessed: vi.fn().mockResolvedValue({ enqueued: 0 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 0, enqueued: 0 });
    expect(deps.markProcessed).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_ok', severity: 'info' }),
    );
  });

  it('marks expired clans processed, writes one audit entry per clan, and publishes exactly one sync', async () => {
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
      markProcessed: vi.fn().mockResolvedValue({ enqueued: 3 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 2, enqueued: 3 });
    expect(deps.findExpiredUnprocessedClans).toHaveBeenCalledWith(now);
    expect(deps.markProcessed).toHaveBeenCalledWith(
      [expired[0].clanId, expired[1].clanId],
      expect.objectContaining({ reason: 'clan.priority.expire', actor_player_id: null }),
    );
    expect(deps.writeAuditEntry).toHaveBeenCalledTimes(2);
    expect(deps.writeAuditEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actor: { kind: 'system', label: 'clan-priority-expirer' },
        actionType: 'clan.priority.expire',
        targetType: 'clan',
        targetId: expired[0].clanId,
        before: {
          priority_expires_at: expired[0].priorityExpiresAt.toISOString(),
          priority_expiry_processed: false,
        },
        after: { priority_expiry_processed: true },
      }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_ok', severity: 'info' }),
    );
  });

  it('does not re-fire for an already-processed clan (findExpiredUnprocessedClans excludes it)', async () => {
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockResolvedValue([]),
      markProcessed: vi.fn().mockResolvedValue({ enqueued: 0 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runClanPriorityExpiryTick(deps);

    expect(result).toEqual({ expiredClans: 0, enqueued: 0 });
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
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
      markProcessed: vi.fn().mockResolvedValue({ enqueued: 1 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };
    expect(Object.keys(deps)).not.toContain('clearHasPriority');
    expect(Object.keys(deps)).not.toContain('updateClanMembers');

    await runClanPriorityExpiryTick(deps);
    expect(deps.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('emits run_failed and rethrows when findExpiredUnprocessedClans throws', async () => {
    const boom = new Error('db unreachable');
    const deps = {
      findExpiredUnprocessedClans: vi.fn().mockRejectedValue(boom),
      markProcessed: vi.fn().mockResolvedValue({ enqueued: 0 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runClanPriorityExpiryTick(deps)).rejects.toThrow('db unreachable');
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_priority_expirer.run_failed', severity: 'error' }),
    );
  });
});
