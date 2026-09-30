import { describe, expect, it, vi } from 'vitest';
import { runRoleExpiryTick } from '../src/tick.js';

describe('runRoleExpiryTick', () => {
  it('clears expired role assignments and notifies revoked sessions, and enqueues Admins.cfg sync', async () => {
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
      // Audit entry and session delete are now committed by
      // `clearExpiredAssignments` itself, inside its own transaction (#992);
      // it reports what it revoked so the tick can do the Redis-only
      // best-effort notify as a separate step.
      clearExpiredAssignments: vi.fn().mockResolvedValue({
        cleared: expired,
        enqueued: 2,
        revokedSessionIds: new Map([[expired[0].playerId, ['sess-1', 'sess-2']]]),
      }),
      invalidatePermissionCache: vi.fn(),
      notifySessionsRevoked: vi.fn().mockResolvedValue(undefined),
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
    expect(deps.notifySessionsRevoked).toHaveBeenCalledWith(expired[0].playerId, [
      'sess-1',
      'sess-2',
    ]);
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.run_ok', severity: 'info' }),
    );
  });

  it('does not emit side effects when a renewal wins after the expiry scan', async () => {
    const now = new Date('2026-07-06T10:00:00.000Z');
    const scanned = [
      {
        playerId: '019e0000-0000-7000-8000-000000000102',
        roleId: '019e0000-0000-7000-8000-000000000202',
        roleExpiresAt: new Date('2026-07-06T09:59:00.000Z'),
        roleComment: 'VIP purchase purchase-A',
      },
    ];
    const deps = {
      now,
      findExpiredAssignments: vi.fn().mockResolvedValue(scanned),
      // The conditional UPDATE observes that a renewal already moved the expiry.
      clearExpiredAssignments: vi
        .fn()
        .mockResolvedValue({ cleared: [], enqueued: 0, revokedSessionIds: new Map() }),
      invalidatePermissionCache: vi.fn(),
      notifySessionsRevoked: vi.fn().mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runRoleExpiryTick(deps)).resolves.toEqual({ expired: 0, enqueued: 0 });
    expect(deps.clearExpiredAssignments).toHaveBeenCalledWith(
      scanned,
      now,
      expect.objectContaining({ reason: 'player.role.expire' }),
    );
    expect(deps.invalidatePermissionCache).not.toHaveBeenCalled();
    expect(deps.notifySessionsRevoked).not.toHaveBeenCalled();
  });

  it('isolates a failing session notification per player instead of aborting the tick (#992)', async () => {
    const now = new Date('2026-07-06T10:00:00.000Z');
    const expired = [
      {
        playerId: '019e0000-0000-7000-8000-000000000103',
        roleId: '019e0000-0000-7000-8000-000000000203',
        roleExpiresAt: new Date('2026-07-06T09:59:00.000Z'),
        roleComment: null,
      },
      {
        playerId: '019e0000-0000-7000-8000-000000000104',
        roleId: '019e0000-0000-7000-8000-000000000204',
        roleExpiresAt: new Date('2026-07-06T09:59:00.000Z'),
        roleComment: null,
      },
    ];
    const deps = {
      now,
      findExpiredAssignments: vi.fn().mockResolvedValue(expired),
      clearExpiredAssignments: vi.fn().mockResolvedValue({
        cleared: expired,
        enqueued: 1,
        revokedSessionIds: new Map([
          [expired[0].playerId, ['sess-1']],
          [expired[1].playerId, ['sess-2']],
        ]),
      }),
      invalidatePermissionCache: vi.fn(),
      notifySessionsRevoked: vi
        .fn()
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValue(undefined),
      diag: { emit: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await runRoleExpiryTick(deps);

    // Both players were cleared regardless — the notify failure for the
    // first must not stop the second's notify, or be reported as a role
    // expiry failure.
    expect(result).toEqual({ expired: 2, enqueued: 1 });
    expect(deps.notifySessionsRevoked).toHaveBeenCalledTimes(2);
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.session_notify_failed' }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.run_ok' }),
    );
  });
});
