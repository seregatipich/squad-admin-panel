import { ROLE_EXPIRY_ALERT_RULE_ID } from '@squad/db/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  type ExpiryNotificationClaim,
  type RoleExpiryReminderDeps,
  runRoleExpiryReminderTick,
} from '../src/reminders.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const PLAYER_ID = '019e0000-0000-7000-8000-000000000301';
const ROLE_ID = '019e0000-0000-7000-8000-000000000401';

const DAY_MS = 24 * 60 * 60 * 1000;

function grantExpiringIn(ms: number) {
  return {
    playerId: PLAYER_ID,
    playerName: 'VipPlayer',
    roleId: ROLE_ID,
    roleName: 'VIP',
    roleExpiresAt: new Date(NOW.getTime() + ms),
  };
}

function claimKey(claim: ExpiryNotificationClaim): string {
  return [
    claim.playerId,
    claim.roleId,
    claim.expiresAt.toISOString(),
    claim.windowDays,
    claim.recipient,
  ].join('|');
}

/**
 * Fakes the deps with an in-memory unique-key set standing in for the
 * `expiry_notifications` ON CONFLICT DO NOTHING behavior, so idempotency and
 * renewal re-arming are exercised against the same key the DB enforces.
 */
function makeDeps(opts: {
  windows?: number[];
  grants: ReturnType<typeof grantExpiringIn>[];
  claimed?: Set<string>;
}) {
  const claimed = opts.claimed ?? new Set<string>();
  let claimSeq = 0;
  const deps = {
    now: NOW,
    loadReminderWindows: vi.fn().mockResolvedValue(opts.windows ?? [7, 3, 1]),
    findExpiringGrants: vi.fn().mockResolvedValue(opts.grants),
    claimNotification: vi.fn(async (claim: ExpiryNotificationClaim) => {
      const key = claimKey(claim);
      if (claimed.has(key)) return null;
      claimed.add(key);
      claimSeq += 1;
      return { id: `claim-${claimSeq}` };
    }),
    insertAlertEvent: vi.fn().mockResolvedValue({ id: 'alert-event-1' }),
    linkAlertEvent: vi.fn().mockResolvedValue(undefined),
    publishAlertFrame: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
  } satisfies RoleExpiryReminderDeps;
  return { deps, claimed };
}

describe('runRoleExpiryReminderTick', () => {
  it('fires exactly one admin notification for the smallest crossed window', async () => {
    const { deps } = makeDeps({ grants: [grantExpiringIn(2.5 * DAY_MS)] });

    const result = await runRoleExpiryReminderTick(deps);

    expect(result).toEqual({ notified: 1 });
    expect(deps.findExpiringGrants).toHaveBeenCalledWith(NOW, 7);
    const adminClaims = deps.claimNotification.mock.calls.filter(
      ([claim]) => claim.recipient === 'admin',
    );
    expect(adminClaims).toHaveLength(1);
    expect(adminClaims[0]?.[0]).toMatchObject({
      playerId: PLAYER_ID,
      roleId: ROLE_ID,
      windowDays: 3,
      recipient: 'admin',
    });
    expect(deps.insertAlertEvent).toHaveBeenCalledTimes(1);
    expect(deps.insertAlertEvent).toHaveBeenCalledWith({
      ruleId: ROLE_EXPIRY_ALERT_RULE_ID,
      payload: expect.objectContaining({ event_kind: 'role_expiring', window_days: 3 }),
    });
    expect(deps.linkAlertEvent).toHaveBeenCalledWith('claim-1', 'alert-event-1');
  });

  it('re-run does not duplicate (dedup insert returns nothing)', async () => {
    const grants = [grantExpiringIn(2.5 * DAY_MS)];
    const { deps, claimed } = makeDeps({ grants });

    await runRoleExpiryReminderTick(deps);
    const second = makeDeps({ grants, claimed });
    const result = await runRoleExpiryReminderTick(second.deps);

    expect(result).toEqual({ notified: 0 });
    expect(second.deps.insertAlertEvent).not.toHaveBeenCalled();
    expect(second.deps.publishAlertFrame).not.toHaveBeenCalled();
  });

  it('renewed expiry re-arms windows (new expires_at → new row)', async () => {
    const claimed = new Set<string>();
    const first = makeDeps({ grants: [grantExpiringIn(2.5 * DAY_MS)], claimed });
    await runRoleExpiryReminderTick(first.deps);

    const renewed = makeDeps({ grants: [grantExpiringIn(2.5 * DAY_MS + 30 * DAY_MS)], claimed });
    // The renewed grant sits outside every window today; move to 2.5 days
    // before the NEW expiry to prove the same window re-fires for it.
    const laterNow = new Date(NOW.getTime() + 30 * DAY_MS);
    const result = await runRoleExpiryReminderTick({ ...renewed.deps, now: laterNow });

    expect(result).toEqual({ notified: 1 });
    expect(renewed.deps.insertAlertEvent).toHaveBeenCalledTimes(1);
    expect(renewed.deps.insertAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ window_days: 3 }) }),
    );
  });

  it('grant created inside a window fires only the smallest window', async () => {
    const { deps } = makeDeps({ grants: [grantExpiringIn(0.5 * DAY_MS)] });

    const result = await runRoleExpiryReminderTick(deps);

    expect(result).toEqual({ notified: 1 });
    const adminWindows = deps.claimNotification.mock.calls
      .filter(([claim]) => claim.recipient === 'admin')
      .map(([claim]) => claim.windowDays);
    expect(adminWindows).toEqual([1]);
  });

  it('publishes the live-bus frame with event_kind role_expiring', async () => {
    const grant = grantExpiringIn(2.5 * DAY_MS);
    const { deps } = makeDeps({ grants: [grant] });

    await runRoleExpiryReminderTick(deps);

    expect(deps.publishAlertFrame).toHaveBeenCalledTimes(1);
    expect(deps.publishAlertFrame).toHaveBeenCalledWith({
      event_kind: 'role_expiring',
      player_id: PLAYER_ID,
      player_name: 'VipPlayer',
      role_id: ROLE_ID,
      role_name: 'VIP',
      expires_at: grant.roleExpiresAt.toISOString(),
      window_days: 3,
    });
  });

  it('records the player row for the in-game warn', async () => {
    const grant = grantExpiringIn(2.5 * DAY_MS);
    const { deps } = makeDeps({ grants: [grant] });

    await runRoleExpiryReminderTick(deps);

    const playerClaims = deps.claimNotification.mock.calls.filter(
      ([claim]) => claim.recipient === 'player',
    );
    expect(playerClaims).toHaveLength(1);
    expect(playerClaims[0]?.[0]).toMatchObject({
      playerId: PLAYER_ID,
      roleId: ROLE_ID,
      expiresAt: grant.roleExpiresAt,
      windowDays: 3,
      recipient: 'player',
    });
  });

  it('skips grants outside every window and already-expired grants', async () => {
    const { deps } = makeDeps({
      grants: [grantExpiringIn(10 * DAY_MS), grantExpiringIn(-1 * DAY_MS)],
    });

    const result = await runRoleExpiryReminderTick(deps);

    expect(result).toEqual({ notified: 0 });
    expect(deps.claimNotification).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.reminders_ok', severity: 'info' }),
    );
  });

  it('emits a failure diagnostic and rethrows when a dep fails', async () => {
    const { deps } = makeDeps({ grants: [grantExpiringIn(2.5 * DAY_MS)] });
    deps.insertAlertEvent.mockRejectedValueOnce(new Error('db down'));

    await expect(runRoleExpiryReminderTick(deps)).rejects.toThrow('db down');
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.reminders_failed', severity: 'error' }),
    );
  });
});
