import { describe, expect, it } from 'vitest';
import {
  activeSubscription,
  bonusTypeLabel,
  daysUntil,
  errorMessage,
  formatAmount,
  formatDateTime,
  type MeSubscription,
  mergeBonusPage,
  subscriptionStatusLabel,
} from './me-vip';

function sub(overrides: Partial<MeSubscription> = {}): MeSubscription {
  return {
    id: 'sub-1',
    player_id: 'player-1',
    tier_id: 'tier-1',
    status: 'active',
    renews_every_days: 30,
    price_bonuses: 100,
    next_renewal_at: '2026-08-26T00:00:00.000Z',
    created_at: '2026-07-27T00:00:00.000Z',
    cancelled_at: null,
    ...overrides,
  };
}

describe('formatAmount', () => {
  it('prefixes credits with a plus', () => {
    expect(formatAmount(120)).toBe('+120');
  });

  it('renders debits with a real minus sign', () => {
    expect(formatAmount(-100)).toBe('−100');
  });

  it('treats zero as a credit', () => {
    expect(formatAmount(0)).toBe('+0');
  });
});

describe('formatDateTime', () => {
  it('renders a dd.mm.yyyy hh:mm stamp', () => {
    const value = new Date(2026, 6, 27, 9, 5).toISOString();
    expect(formatDateTime(value)).toBe('27.07.2026 09:05');
  });

  it('renders a dash for a missing value', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });

  it('renders a dash instead of throwing on an unparseable value', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-07-27T00:00:00.000Z');

  it('rounds a future date up to whole days', () => {
    expect(daysUntil('2026-08-01T12:00:00.000Z', now)).toBe(6);
  });

  it('floors a past date at zero', () => {
    expect(daysUntil('2026-07-01T00:00:00.000Z', now)).toBe(0);
  });

  it('returns null without a date', () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('nonsense', now)).toBeNull();
  });
});

describe('activeSubscription', () => {
  it('finds the single active row', () => {
    const rows = [sub({ id: 'old', status: 'expired' }), sub({ id: 'live' })];
    expect(activeSubscription(rows)?.id).toBe('live');
  });

  it('returns null when nothing is active', () => {
    expect(activeSubscription([sub({ status: 'cancelled' })])).toBeNull();
    expect(activeSubscription([])).toBeNull();
  });
});

describe('label maps', () => {
  it('translates known statuses and falls back to the raw value', () => {
    expect(subscriptionStatusLabel('active')).toBe('Активна');
    expect(subscriptionStatusLabel('cancelled')).toBe('Отменена');
    expect(subscriptionStatusLabel('expired')).toBe('Истекла');
    expect(subscriptionStatusLabel('weird')).toBe('weird');
  });

  it('translates known ledger types and falls back to the raw value', () => {
    expect(bonusTypeLabel('spend')).toBe('Списание');
    expect(bonusTypeLabel('earn_seed')).toBe('Сид');
    expect(bonusTypeLabel('mystery')).toBe('mystery');
  });
});

describe('errorMessage', () => {
  it('maps known API codes to Russian copy', () => {
    expect(errorMessage('insufficient_balance')).toBe('Недостаточно бонусов.');
    expect(errorMessage('already_subscribed')).toBe('У вас уже есть активная подписка.');
  });

  it('keeps an unknown code visible in the fallback', () => {
    expect(errorMessage('brand_new_code')).toContain('brand_new_code');
  });

  it('has a message for a missing code', () => {
    expect(errorMessage(null)).toBe('Не удалось выполнить операцию.');
    expect(errorMessage(undefined)).toBe('Не удалось выполнить операцию.');
  });
});

describe('mergeBonusPage', () => {
  const entry = (id: number) => ({
    id,
    amount: id,
    type: 'spend',
    reference_type: null,
    comment: null,
    created_at: '2026-07-27T00:00:00.000Z',
  });

  it('appends the next page', () => {
    expect(mergeBonusPage([entry(3)], [entry(2), entry(1)]).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('drops ids already present', () => {
    expect(mergeBonusPage([entry(3), entry(2)], [entry(2), entry(1)]).map((e) => e.id)).toEqual([
      3, 2, 1,
    ]);
  });
});
