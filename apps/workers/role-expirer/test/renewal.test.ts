import { describe, expect, it, vi } from 'vitest';
import {
  type DueSubscription,
  runSubscriptionRenewalTick,
  type SubscriptionRenewalDeps,
} from '../src/renewal.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-07-27T12:00:00.000Z');
const PLAYER_ID = '019e0000-0000-7000-8000-000000000501';
const SUB_ID = '019e0000-0000-7000-8000-000000000601';
const ROLE_ID = '019e0000-0000-7000-8000-000000000701';

function due(overrides: Partial<DueSubscription> = {}): DueSubscription {
  return {
    id: SUB_ID,
    playerId: PLAYER_ID,
    playerName: 'VipPlayer',
    tierId: '019e0000-0000-7000-8000-000000000801',
    tierName: 'VIP',
    roleId: ROLE_ID,
    priceBonuses: 100,
    renewsEveryDays: 30,
    nextRenewalAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

function makeDeps(opts: {
  dueSubscriptions: DueSubscription[];
  charge?: SubscriptionRenewalDeps['chargeRenewal'];
}) {
  const deps = {
    now: NOW,
    findDueSubscriptions: vi.fn().mockResolvedValue(opts.dueSubscriptions),
    chargeRenewal:
      opts.charge ??
      vi.fn().mockResolvedValue({
        status: 'ok',
        balance: 400,
        roleExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
        enqueued: 1,
      }),
    expireSubscription: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    notifySubscriptionExpired: vi.fn().mockResolvedValue(undefined),
    invalidatePermissionCache: vi.fn(),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
  } satisfies SubscriptionRenewalDeps;
  return deps;
}

describe('runSubscriptionRenewalTick', () => {
  it('reports a no-op run when nothing is due', async () => {
    const deps = makeDeps({ dueSubscriptions: [] });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toEqual({ renewed: 0, expired: 0, enqueued: 0 });
    expect(deps.chargeRenewal).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'role_expirer.renewals_ok' }),
    );
  });

  it('charges the snapshot price and advances the schedule from the due date', async () => {
    const subscription = due({ nextRenewalAt: new Date('2026-07-27T00:00:00.000Z') });
    const deps = makeDeps({ dueSubscriptions: [subscription] });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 1, expired: 0 });
    expect(deps.chargeRenewal).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: SUB_ID,
        playerId: PLAYER_ID,
        roleId: ROLE_ID,
        price: 100,
        days: 30,
        nextRenewalAt: new Date('2026-08-26T00:00:00.000Z'),
      }),
    );
    expect(deps.expireSubscription).not.toHaveBeenCalled();
  });

  it('audits a successful renewal and enqueues one Admins.cfg sync for the run', async () => {
    const deps = makeDeps({ dueSubscriptions: [due(), due({ id: 'sub-2' })] });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 2, enqueued: 2 });
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'player.subscription.renew',
        targetType: 'player',
        targetId: PLAYER_ID,
      }),
    );
    expect(deps.invalidatePermissionCache).toHaveBeenCalledWith(PLAYER_ID);
  });

  it('expires the subscription and notifies the player when the balance is short', async () => {
    const charge = vi.fn().mockResolvedValue({ status: 'insufficient_balance', balance: 10 });
    const deps = makeDeps({ dueSubscriptions: [due()], charge });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 0, expired: 1 });
    expect(deps.expireSubscription).toHaveBeenCalledWith(SUB_ID, NOW);
    expect(deps.notifySubscriptionExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: 'subscription_expired',
        player_id: PLAYER_ID,
        player_name: 'VipPlayer',
        subscription_id: SUB_ID,
        reason: 'insufficient_balance',
        price_bonuses: 100,
        balance: 10,
      }),
    );
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'player.subscription.expire' }),
    );
  });

  it('expires the subscription when the tier role can no longer be granted', async () => {
    const charge = vi.fn().mockResolvedValue({ status: 'role_conflict' });
    const deps = makeDeps({ dueSubscriptions: [due()], charge });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 0, expired: 1 });
    expect(deps.notifySubscriptionExpired).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'role_conflict' }),
    );
  });

  it('expires the internal subscription when external lifecycle becomes the sole VIP writer', async () => {
    const charge = vi.fn().mockResolvedValue({ status: 'vip_lifecycle_required' });
    const deps = makeDeps({ dueSubscriptions: [due()], charge });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 0, expired: 1 });
    expect(deps.notifySubscriptionExpired).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'vip_lifecycle_required' }),
    );
  });

  it('keeps renewing the rest of the batch when one subscription fails', async () => {
    const charge = vi
      .fn()
      .mockResolvedValueOnce({ status: 'insufficient_balance', balance: 0 })
      .mockResolvedValue({
        status: 'ok',
        balance: 400,
        roleExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
        enqueued: 1,
      });
    const deps = makeDeps({
      dueSubscriptions: [due(), due({ id: 'sub-2', playerId: 'player-2' })],
      charge,
    });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toMatchObject({ renewed: 1, expired: 1 });
  });

  it('skips a subscription cancelled between the scan and the charge', async () => {
    const charge = vi.fn().mockResolvedValue({ status: 'not_active' });
    const deps = makeDeps({ dueSubscriptions: [due()], charge });

    const result = await runSubscriptionRenewalTick(deps);

    expect(result).toEqual({ renewed: 0, expired: 0, enqueued: 0 });
    expect(deps.expireSubscription).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
    expect(deps.notifySubscriptionExpired).not.toHaveBeenCalled();
  });

  it('emits a failure diag event and rethrows when the scan itself fails', async () => {
    const deps = makeDeps({ dueSubscriptions: [] });
    deps.findDueSubscriptions = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(runSubscriptionRenewalTick(deps)).rejects.toThrow('db down');
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'role_expirer.renewals_failed',
        severity: 'error',
      }),
    );
  });
});
