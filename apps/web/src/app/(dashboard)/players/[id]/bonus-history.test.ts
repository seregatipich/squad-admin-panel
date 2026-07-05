import { describe, expect, it } from 'vitest';
import {
  type BonusFilters,
  type BonusTransaction,
  buildBonusQuery,
  dateInputToIso,
  EMPTY_BONUS_FILTERS,
  formatAmount,
  isCredit,
  mergeBonusPage,
  prependTransaction,
  sourceLabel,
  typeLabel,
  validateAdjust,
} from './bonus-history';

function filters(overrides: Partial<BonusFilters> = {}): BonusFilters {
  return { ...EMPTY_BONUS_FILTERS, ...overrides };
}

function tx(id: number, overrides: Partial<BonusTransaction> = {}): BonusTransaction {
  return {
    id,
    player_id: 'p1',
    amount: 10,
    type: 'earn_online',
    reference_type: 'daily_presence',
    reference_id: '2026-07-01',
    comment: null,
    actor_player_id: null,
    created_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildBonusQuery', () => {
  it('emits only the limit when filters are empty', () => {
    expect(buildBonusQuery(EMPTY_BONUS_FILTERS)).toBe('?limit=50');
  });

  it('includes type and a from/to window as ISO bounds', () => {
    const q = buildBonusQuery(filters({ type: 'adjust', from: '2026-06-01', to: '2026-06-30' }));
    const params = new URLSearchParams(q.slice(1));
    expect(params.get('type')).toBe('adjust');
    expect(params.get('from')).toBe('2026-06-01T00:00:00.000Z');
    expect(params.get('to')).toBe('2026-06-30T23:59:59.999Z');
  });

  it('appends the before cursor when provided', () => {
    const q = buildBonusQuery(EMPTY_BONUS_FILTERS, 42);
    expect(new URLSearchParams(q.slice(1)).get('before')).toBe('42');
  });

  it('omits the cursor when null', () => {
    expect(
      new URLSearchParams(buildBonusQuery(EMPTY_BONUS_FILTERS, null).slice(1)).has('before'),
    ).toBe(false);
  });
});

describe('dateInputToIso', () => {
  it('returns null for empty input', () => {
    expect(dateInputToIso('', false)).toBeNull();
  });

  it('maps to start or end of day', () => {
    expect(dateInputToIso('2026-07-01', false)).toBe('2026-07-01T00:00:00.000Z');
    expect(dateInputToIso('2026-07-01', true)).toBe('2026-07-01T23:59:59.999Z');
  });
});

describe('mergeBonusPage', () => {
  it('replaces on refresh and dedupes', () => {
    const merged = mergeBonusPage([tx(3)], [tx(2), tx(2), tx(1)], false);
    expect(merged.map((row) => row.id)).toEqual([2, 1]);
  });

  it('appends without duplicating on load-more', () => {
    const merged = mergeBonusPage([tx(3), tx(2)], [tx(2), tx(1)], true);
    expect(merged.map((row) => row.id)).toEqual([3, 2, 1]);
  });
});

describe('prependTransaction', () => {
  it('adds a fresh row to the front', () => {
    expect(prependTransaction([tx(2)], tx(3)).map((row) => row.id)).toEqual([3, 2]);
  });

  it('is a no-op for an already present id', () => {
    const prev = [tx(3)];
    expect(prependTransaction(prev, tx(3))).toBe(prev);
  });
});

describe('labels and formatting', () => {
  it('translates known types', () => {
    expect(typeLabel('adjust')).toBe('Корректировка');
    expect(typeLabel('earn_boost')).toBe('Буст');
  });

  it('falls back to the raw type', () => {
    expect(typeLabel('mystery')).toBe('mystery');
  });

  it('classifies credits', () => {
    expect(isCredit('earn_online')).toBe(true);
    expect(isCredit('adjust')).toBe(false);
    expect(isCredit('spend')).toBe(false);
  });

  it('formats the source with a reference id', () => {
    expect(sourceLabel({ reference_type: 'daily_presence', reference_id: '2026-07-01' })).toBe(
      'Начисление за день · 2026-07-01',
    );
  });

  it('renders a dash for a missing reference', () => {
    expect(sourceLabel({ reference_type: null, reference_id: null })).toBe('—');
  });

  it('prefixes positive amounts with a plus sign', () => {
    expect(formatAmount(25)).toBe('+25');
    expect(formatAmount(-25)).toBe('-25');
  });
});

describe('validateAdjust', () => {
  it('accepts a signed integer with a comment', () => {
    expect(validateAdjust('-15', ' correction ')).toEqual({ amount: -15, comment: 'correction' });
  });

  it('rejects a blank amount', () => {
    expect(validateAdjust('', 'x')).toBe('Укажите сумму корректировки.');
  });

  it('rejects a non-integer amount', () => {
    expect(validateAdjust('1.5', 'x')).toBe('Сумма должна быть целым числом.');
  });

  it('rejects zero', () => {
    expect(validateAdjust('0', 'x')).toBe('Сумма не может быть нулевой.');
  });

  it('rejects a blank comment', () => {
    expect(validateAdjust('10', '   ')).toBe('Комментарий обязателен.');
  });
});
