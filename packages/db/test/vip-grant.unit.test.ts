import { describe, expect, it } from 'vitest';
import {
  planVipGrant,
  type VipGrantTargetState,
  type VipGrantTier,
} from '../src/economy/vip-grant.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-07-27T12:00:00.000Z');
const VIP_ROLE = '019e0000-0000-7000-8000-0000000000a1';
const OTHER_ROLE = '019e0000-0000-7000-8000-0000000000a2';

function tier(overrides: Partial<VipGrantTier> = {}): VipGrantTier {
  return { roleId: VIP_ROLE, days: 30, price: 100, ...overrides };
}

function state(overrides: Partial<VipGrantTargetState> = {}): VipGrantTargetState {
  return { balance: 500, roleId: null, roleExpiresAt: null, ...overrides };
}

describe('planVipGrant', () => {
  it('charges the price and grants the tier role from now when the player has no role', () => {
    const plan = planVipGrant(state(), tier(), NOW);

    expect(plan).toEqual({
      status: 'ok',
      price: 100,
      nextBalance: 400,
      roleId: VIP_ROLE,
      roleExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
  });

  it('rejects with insufficient_balance and leaves the balance untouched', () => {
    const plan = planVipGrant(state({ balance: 99 }), tier({ price: 100 }), NOW);

    expect(plan).toEqual({ status: 'insufficient_balance', balance: 99 });
  });

  it('allows a purchase that spends the balance down to exactly zero', () => {
    const plan = planVipGrant(state({ balance: 100 }), tier({ price: 100 }), NOW);

    expect(plan).toMatchObject({ status: 'ok', nextBalance: 0 });
  });

  it('rejects with role_conflict when the player already holds a different role', () => {
    const plan = planVipGrant(
      state({ roleId: OTHER_ROLE, roleExpiresAt: new Date(NOW.getTime() + DAY_MS) }),
      tier(),
      NOW,
    );

    expect(plan).toEqual({ status: 'role_conflict' });
  });

  it('rejects with role_permanent when the player holds the tier role with no expiry', () => {
    const plan = planVipGrant(state({ roleId: VIP_ROLE, roleExpiresAt: null }), tier(), NOW);

    expect(plan).toEqual({ status: 'role_permanent' });
  });

  it('extends from the current expiry when the same role is still active', () => {
    const currentExpiry = new Date(NOW.getTime() + 10 * DAY_MS);

    const plan = planVipGrant(
      state({ roleId: VIP_ROLE, roleExpiresAt: currentExpiry }),
      tier({ days: 30 }),
      NOW,
    );

    expect(plan).toMatchObject({
      status: 'ok',
      roleExpiresAt: new Date(currentExpiry.getTime() + 30 * DAY_MS),
    });
  });

  it('extends from now when the same role already lapsed', () => {
    const plan = planVipGrant(
      state({ roleId: VIP_ROLE, roleExpiresAt: new Date(NOW.getTime() - DAY_MS) }),
      tier({ days: 30 }),
      NOW,
    );

    expect(plan).toMatchObject({
      status: 'ok',
      roleExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
  });

  it('treats a free tier as a pure grant', () => {
    const plan = planVipGrant(state({ balance: 0 }), tier({ price: 0 }), NOW);

    expect(plan).toMatchObject({ status: 'ok', nextBalance: 0 });
  });
});

describe('nextRenewalAfter', () => {
  it('advances the schedule from the due date, not from the wall clock', async () => {
    const { nextRenewalAfter } = await import('../src/economy/vip-grant.js');
    const due = new Date('2026-07-01T00:00:00.000Z');

    expect(nextRenewalAfter(due, 30)).toEqual(new Date('2026-07-31T00:00:00.000Z'));
  });
});
