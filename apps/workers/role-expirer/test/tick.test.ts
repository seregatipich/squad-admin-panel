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
      },
    ];
    const deps = {
      now,
      findExpiredAssignments: vi.fn().mockResolvedValue(expired),
      clearExpiredAssignments: vi.fn().mockResolvedValue(undefined),
      writeAuditEntry: vi.fn().mockResolvedValue(undefined),
      publishAdminsCfgSync: vi.fn().mockResolvedValue({ enqueued: 2 }),
      invalidatePermissionCache: vi.fn(),
      revokeAllForPlayer: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runRoleExpiryTick(deps);

    expect(result).toEqual({ expired: 1, enqueued: 2 });
    expect(deps.findExpiredAssignments).toHaveBeenCalledWith(now);
    expect(deps.clearExpiredAssignments).toHaveBeenCalledWith([expired[0].playerId], now);
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
    expect(deps.publishAdminsCfgSync).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'player.role.expire',
        actor_player_id: null,
      }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.run_ok', severity: 'info' }),
    );
  });
});
