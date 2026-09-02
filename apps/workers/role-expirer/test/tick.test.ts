import { describe, expect, it, vi } from 'vitest';
import { runRoleExpiryTick } from '../src/tick.js';

describe('runRoleExpiryTick', () => {
  it('clears expired role assignments, writes audit, and enqueues Admins.cfg sync', async () => {
    const now = new Date('2026-07-06T10:00:00.000Z');
    const expired = [
      {
        playerId: '019e0000-0000-7000-8000-000000000101',
        roleId: '019e0000-0000-7000-8000-000000000201',
        roleExpiresAt: new Date('2026-07-06T09:59:00.000Z'),
        roleComment: 'VIP истек',
        roleLifecycleEventId: 'vip-expired-101',
      },
    ];
    const deps = {
      now,
      findExpiredAssignments: vi.fn().mockResolvedValue(expired),
      clearExpiredAssignments: vi.fn().mockResolvedValue({ cleared: expired, enqueued: 2 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      invalidatePermissionCache: vi.fn(),
      revokeAllForPlayer: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runRoleExpiryTick(deps);

    expect(result).toEqual({ expired: 1, enqueued: 2 });
    expect(deps.findExpiredAssignments).toHaveBeenCalledWith(now);
    expect(deps.clearExpiredAssignments).toHaveBeenCalledWith(
      expired,
      now,
      expect.objectContaining({ reason: 'player.role.expire', actor_player_id: null }),
    );
    expect(deps.invalidatePermissionCache).toHaveBeenCalledWith(expired[0].playerId);
    expect(deps.revokeAllForPlayer).toHaveBeenCalledWith(expired[0].playerId);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'system', label: 'role-expirer' },
        actionType: 'player.role.expire',
        targetType: 'player',
        targetId: expired[0].playerId,
        before: {
          role_id: expired[0].roleId,
          role_expires_at: expired[0].roleExpiresAt.toISOString(),
          role_comment: expired[0].roleComment,
        },
        after: { role_id: null, role_expires_at: null, role_comment: null },
      }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.run_ok', severity: 'info' }),
    );
  });

  it('does not emit side effects when a lifecycle renewal wins after the expiry scan', async () => {
    const now = new Date('2026-07-06T10:00:00.000Z');
    const scanned = [
      {
        playerId: '019e0000-0000-7000-8000-000000000102',
        roleId: '019e0000-0000-7000-8000-000000000202',
        roleExpiresAt: new Date('2026-07-06T09:59:00.000Z'),
        roleComment: 'VIP purchase purchase-A',
        roleLifecycleEventId: 'purchase-A-event',
      },
    ];
    const deps = {
      now,
      findExpiredAssignments: vi.fn().mockResolvedValue(scanned),
      // The conditional UPDATE observes that lifecycle already renewed the row.
      clearExpiredAssignments: vi.fn().mockResolvedValue({ cleared: [], enqueued: 0 }),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      invalidatePermissionCache: vi.fn(),
      revokeAllForPlayer: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runRoleExpiryTick(deps)).resolves.toEqual({ expired: 0, enqueued: 0 });
    expect(deps.clearExpiredAssignments).toHaveBeenCalledWith(
      scanned,
      now,
      expect.objectContaining({ reason: 'player.role.expire' }),
    );
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
    expect(deps.invalidatePermissionCache).not.toHaveBeenCalled();
    expect(deps.revokeAllForPlayer).not.toHaveBeenCalled();
  });
});
