import { describe, expect, it } from 'vitest';
import {
  type EconomyFormState,
  type EconomySettings,
  emptyTierForm,
  formatTierDuration,
  formatTierPrice,
  formatUpdatedAt,
  settingsToForm,
  tierToForm,
  type VipTier,
  type VipTierFormState,
  validateEconomyForm,
  validateVipTierForm,
} from './helpers';

const COEFFICIENT_ERROR = 'Введите число от 0 до 1000.';
const SEED_THRESHOLD_ERROR = 'Введите целое число от 0 до 100.';
const WINDOWS_ERROR = 'Введите от 1 до 10 целых чисел от 1 до 90 через запятую.';
const TIER_NAME_ERROR = 'Введите название от 1 до 64 символов.';
const TIER_ROLE_ERROR = 'Выберите роль.';
const TIER_DESCRIPTION_ERROR = 'Описание не длиннее 1024 символов.';
const TIER_DAYS_ERROR = 'Введите целое число от 1 до 3650 или оставьте поле пустым.';
const TIER_PRICE_ERROR = 'Введите целое число от 0 до 2147483647 или оставьте поле пустым.';
const TIER_PRICE_NEEDS_DAYS_ERROR =
  'Цена требует срок по умолчанию: укажите срок или очистите цену.';
const TIER_SORT_ORDER_ERROR = 'Введите целое число от 0 до 100000.';

function makeSettings(overrides: Partial<EconomySettings> = {}): EconomySettings {
  return {
    k_online: overrides.k_online ?? 1,
    k_boost: overrides.k_boost ?? 2,
    k_seed: overrides.k_seed ?? 3,
    seed_threshold: overrides.seed_threshold ?? 40,
    economy_enabled: overrides.economy_enabled ?? false,
    privilege_costs: overrides.privilege_costs ?? {},
    seed_reward_threshold_hours_per_month: overrides.seed_reward_threshold_hours_per_month ?? 0,
    seed_reward_role_id: overrides.seed_reward_role_id ?? null,
    vip_expiry_windows_days: overrides.vip_expiry_windows_days ?? [7, 3, 1],
    vip_expiry_warn_in_game: overrides.vip_expiry_warn_in_game ?? true,
    updated_at: overrides.updated_at ?? null,
    updated_by_player_id: overrides.updated_by_player_id ?? null,
  };
}

function makeForm(overrides: Partial<EconomyFormState> = {}): EconomyFormState {
  return {
    kOnline: overrides.kOnline ?? '1',
    kBoost: overrides.kBoost ?? '2',
    kSeed: overrides.kSeed ?? '3',
    seedThreshold: overrides.seedThreshold ?? '40',
    economyEnabled: overrides.economyEnabled ?? false,
    vipExpiryWindows: overrides.vipExpiryWindows ?? '7, 3, 1',
    vipExpiryWarnInGame: overrides.vipExpiryWarnInGame ?? true,
  };
}

describe('settingsToForm', () => {
  it('maps API settings into string-backed form fields', () => {
    const form = settingsToForm(
      makeSettings({ k_boost: 4.5, seed_threshold: 25, economy_enabled: true }),
    );
    expect(form).toEqual({
      kOnline: '1',
      kBoost: '4.5',
      kSeed: '3',
      seedThreshold: '25',
      economyEnabled: true,
      vipExpiryWindows: '7, 3, 1',
      vipExpiryWarnInGame: true,
    });
  });

  it('maps configured reminder windows and defaults missing wire fields', () => {
    const form = settingsToForm(
      makeSettings({ vip_expiry_windows_days: [14, 5, 2], vip_expiry_warn_in_game: false }),
    );
    expect(form.vipExpiryWindows).toBe('14, 5, 2');
    expect(form.vipExpiryWarnInGame).toBe(false);
    // The base makeSettings() omits both wire fields — the form falls back.
    const fallback = settingsToForm(makeSettings());
    expect(fallback.vipExpiryWindows).toBe('7, 3, 1');
    expect(fallback.vipExpiryWarnInGame).toBe(true);
  });
});

describe('validateEconomyForm', () => {
  it('accepts a valid form and produces the API payload', () => {
    const result = validateEconomyForm(
      makeForm({
        kOnline: '1.5',
        kBoost: '4',
        kSeed: '6',
        seedThreshold: '30',
        economyEnabled: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        k_online: 1.5,
        k_boost: 4,
        k_seed: 6,
        seed_threshold: 30,
        economy_enabled: true,
        vip_expiry_windows_days: [7, 3, 1],
        vip_expiry_warn_in_game: true,
      },
    });
  });

  it('parses custom reminder windows and the in-game warn flag', () => {
    const result = validateEconomyForm(
      makeForm({ vipExpiryWindows: '14,5, 2', vipExpiryWarnInGame: false }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.vip_expiry_windows_days).toEqual([14, 5, 2]);
      expect(result.value.vip_expiry_warn_in_game).toBe(false);
    }
  });

  it('rejects out-of-range reminder windows', () => {
    for (const raw of ['0', '91', '7, 0']) {
      const result = validateEconomyForm(makeForm({ vipExpiryWindows: raw }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toEqual({ vipExpiryWindows: WINDOWS_ERROR });
    }
  });

  it('rejects empty or non-numeric reminder windows', () => {
    for (const raw of ['', '  ', '7,abc', '3.5']) {
      const result = validateEconomyForm(makeForm({ vipExpiryWindows: raw }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toEqual({ vipExpiryWindows: WINDOWS_ERROR });
    }
  });

  it('rejects more than ten reminder windows and collapses duplicates', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => i + 1).join(',');
    const tooMany = validateEconomyForm(makeForm({ vipExpiryWindows: eleven }));
    expect(tooMany.ok).toBe(false);

    const withDuplicates = validateEconomyForm(makeForm({ vipExpiryWindows: '7,7,3' }));
    expect(withDuplicates.ok).toBe(true);
    if (withDuplicates.ok) {
      expect(withDuplicates.value.vip_expiry_windows_days).toEqual([7, 3]);
    }
  });

  it('rejects a negative coefficient', () => {
    const result = validateEconomyForm(makeForm({ kOnline: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ kOnline: COEFFICIENT_ERROR });
  });

  it('rejects a coefficient above the maximum', () => {
    const result = validateEconomyForm(makeForm({ kBoost: '5000' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ kBoost: COEFFICIENT_ERROR });
  });

  it('rejects a non-numeric coefficient', () => {
    const result = validateEconomyForm(makeForm({ kSeed: 'abc' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ kSeed: COEFFICIENT_ERROR });
  });

  it('rejects a fractional seed threshold', () => {
    const result = validateEconomyForm(makeForm({ seedThreshold: '40.5' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ seedThreshold: SEED_THRESHOLD_ERROR });
  });

  it('rejects a seed threshold above the maximum', () => {
    const result = validateEconomyForm(makeForm({ seedThreshold: '150' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ seedThreshold: SEED_THRESHOLD_ERROR });
  });

  it('rejects an empty field', () => {
    const result = validateEconomyForm(makeForm({ kOnline: '  ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ kOnline: COEFFICIENT_ERROR });
  });

  it('rejects an empty seed threshold', () => {
    const result = validateEconomyForm(makeForm({ seedThreshold: '  ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ seedThreshold: SEED_THRESHOLD_ERROR });
  });

  it('accepts zero as the lower bound', () => {
    const result = validateEconomyForm(makeForm({ kOnline: '0', seedThreshold: '0' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.k_online).toBe(0);
      expect(result.value.seed_threshold).toBe(0);
    }
  });
});

function makeTier(overrides: Partial<VipTier> = {}): VipTier {
  return {
    id: overrides.id ?? 'tier-1',
    name: overrides.name ?? 'VIP Bronze',
    role_id: overrides.role_id ?? 'role-1',
    description: overrides.description ?? null,
    default_days: overrides.default_days ?? null,
    price_bonuses: overrides.price_bonuses ?? null,
    sort_order: overrides.sort_order ?? 0,
    is_active: overrides.is_active ?? true,
    created_at: overrides.created_at ?? '2026-07-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-07-01T00:00:00.000Z',
  };
}

function makeTierForm(overrides: Partial<VipTierFormState> = {}): VipTierFormState {
  return {
    name: overrides.name ?? 'VIP Bronze',
    roleId: overrides.roleId ?? 'role-1',
    description: overrides.description ?? '',
    defaultDays: overrides.defaultDays ?? '',
    priceBonuses: overrides.priceBonuses ?? '',
    sortOrder: overrides.sortOrder ?? '0',
    isActive: overrides.isActive ?? true,
  };
}

describe('tierToForm / emptyTierForm', () => {
  it('maps a tier into string-backed form fields', () => {
    const form = tierToForm(
      makeTier({
        description: 'reserve',
        default_days: 30,
        price_bonuses: 500,
        sort_order: 10,
        is_active: false,
      }),
    );
    expect(form).toEqual({
      name: 'VIP Bronze',
      roleId: 'role-1',
      description: 'reserve',
      defaultDays: '30',
      priceBonuses: '500',
      sortOrder: '10',
      isActive: false,
    });
  });

  it('maps null description, default_days and price_bonuses to empty strings', () => {
    const form = tierToForm(
      makeTier({ description: null, default_days: null, price_bonuses: null }),
    );
    expect(form.description).toBe('');
    expect(form.defaultDays).toBe('');
    expect(form.priceBonuses).toBe('');
  });

  it('produces an empty active form for creation', () => {
    expect(emptyTierForm()).toEqual({
      name: '',
      roleId: '',
      description: '',
      defaultDays: '',
      priceBonuses: '',
      sortOrder: '0',
      isActive: true,
    });
  });
});

describe('validateVipTierForm', () => {
  it('accepts a valid tier form', () => {
    const result = validateVipTierForm(
      makeTierForm({
        description: ' reserve slot ',
        defaultDays: '30',
        priceBonuses: '500',
        sortOrder: '10',
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'VIP Bronze',
        role_id: 'role-1',
        description: 'reserve slot',
        default_days: 30,
        price_bonuses: 500,
        sort_order: 10,
        is_active: true,
      },
    });
  });

  it('maps empty description and default_days to null', () => {
    const result = validateVipTierForm(makeTierForm({ description: '  ', defaultDays: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBeNull();
      expect(result.value.default_days).toBeNull();
      expect(result.value.price_bonuses).toBeNull();
    }
  });

  it('rejects empty name', () => {
    const result = validateVipTierForm(makeTierForm({ name: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ name: TIER_NAME_ERROR });
  });

  it('rejects a description longer than the maximum', () => {
    const result = validateVipTierForm(makeTierForm({ description: 'x'.repeat(1025) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ description: TIER_DESCRIPTION_ERROR });
  });

  it('rejects a missing role', () => {
    const result = validateVipTierForm(makeTierForm({ roleId: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ roleId: TIER_ROLE_ERROR });
  });

  it('rejects default_days out of range', () => {
    const tooLow = validateVipTierForm(makeTierForm({ defaultDays: '0' }));
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.errors).toEqual({ defaultDays: TIER_DAYS_ERROR });

    const tooHigh = validateVipTierForm(makeTierForm({ defaultDays: '3651' }));
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.errors).toEqual({ defaultDays: TIER_DAYS_ERROR });

    const fractional = validateVipTierForm(makeTierForm({ defaultDays: '1.5' }));
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.errors).toEqual({ defaultDays: TIER_DAYS_ERROR });
  });

  it('rejects negative sort_order', () => {
    const result = validateVipTierForm(makeTierForm({ sortOrder: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ sortOrder: TIER_SORT_ORDER_ERROR });
  });

  it('rejects price_bonuses out of range', () => {
    const negative = validateVipTierForm(makeTierForm({ priceBonuses: '-1' }));
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.errors).toEqual({ priceBonuses: TIER_PRICE_ERROR });

    const tooHigh = validateVipTierForm(makeTierForm({ priceBonuses: '2147483648' }));
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.errors).toEqual({ priceBonuses: TIER_PRICE_ERROR });
  });

  it('requires a default duration when a price is set (mirrors the server price_requires_days rule)', () => {
    const result = validateVipTierForm(makeTierForm({ priceBonuses: '500', defaultDays: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ defaultDays: TIER_PRICE_NEEDS_DAYS_ERROR });
  });
});

describe('formatTierDuration', () => {
  it('renders a bounded duration in days', () => {
    expect(formatTierDuration(30)).toBe('30 дн.');
  });

  it('renders null as unlimited', () => {
    expect(formatTierDuration(null)).toBe('бессрочно');
  });
});

describe('formatUpdatedAt', () => {
  it('returns a placeholder when never saved', () => {
    expect(formatUpdatedAt(null)).toBe('ещё не сохранялись');
  });

  it('returns a placeholder for an invalid timestamp', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('ещё не сохранялись');
  });

  it('formats a valid ISO timestamp', () => {
    expect(formatUpdatedAt('2026-07-05T00:00:00.000Z')).toBe(
      new Date('2026-07-05T00:00:00.000Z').toLocaleString('ru-RU'),
    );
  });
});

describe('formatTierPrice', () => {
  it('renders a bonus price', () => {
    expect(formatTierPrice(500)).toBe('500 бонусов');
  });

  it('renders null as not purchasable', () => {
    expect(formatTierPrice(null)).toBe('не продаётся');
  });
});
