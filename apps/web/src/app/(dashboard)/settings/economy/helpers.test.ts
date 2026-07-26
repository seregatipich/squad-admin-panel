import { describe, expect, it } from 'vitest';
import {
  type EconomyFormState,
  type EconomySettings,
  emptyTierForm,
  formatTierDuration,
  formatUpdatedAt,
  settingsToForm,
  tierToForm,
  type VipTier,
  type VipTierFormState,
  validateEconomyForm,
  validateVipTierForm,
} from './helpers';

function makeSettings(overrides: Partial<EconomySettings> = {}): EconomySettings {
  return {
    k_online: overrides.k_online ?? 1,
    k_boost: overrides.k_boost ?? 2,
    k_seed: overrides.k_seed ?? 3,
    seed_threshold: overrides.seed_threshold ?? 40,
    economy_enabled: overrides.economy_enabled ?? false,
    privilege_costs: overrides.privilege_costs ?? {},
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
    });
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
      value: { k_online: 1.5, k_boost: 4, k_seed: 6, seed_threshold: 30, economy_enabled: true },
    });
  });

  it('rejects a negative coefficient', () => {
    const result = validateEconomyForm(makeForm({ kOnline: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.kOnline).toBeTruthy();
  });

  it('rejects a coefficient above the maximum', () => {
    const result = validateEconomyForm(makeForm({ kBoost: '5000' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.kBoost).toBeTruthy();
  });

  it('rejects a non-numeric coefficient', () => {
    const result = validateEconomyForm(makeForm({ kSeed: 'abc' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.kSeed).toBeTruthy();
  });

  it('rejects a fractional seed threshold', () => {
    const result = validateEconomyForm(makeForm({ seedThreshold: '40.5' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.seedThreshold).toBeTruthy();
  });

  it('rejects a seed threshold above the maximum', () => {
    const result = validateEconomyForm(makeForm({ seedThreshold: '150' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.seedThreshold).toBeTruthy();
  });

  it('rejects an empty field', () => {
    const result = validateEconomyForm(makeForm({ kOnline: '  ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.kOnline).toBeTruthy();
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
    sortOrder: overrides.sortOrder ?? '0',
    isActive: overrides.isActive ?? true,
  };
}

describe('tierToForm / emptyTierForm', () => {
  it('maps a tier into string-backed form fields', () => {
    const form = tierToForm(
      makeTier({ description: 'reserve', default_days: 30, sort_order: 10, is_active: false }),
    );
    expect(form).toEqual({
      name: 'VIP Bronze',
      roleId: 'role-1',
      description: 'reserve',
      defaultDays: '30',
      sortOrder: '10',
      isActive: false,
    });
  });

  it('produces an empty active form for creation', () => {
    expect(emptyTierForm()).toEqual({
      name: '',
      roleId: '',
      description: '',
      defaultDays: '',
      sortOrder: '0',
      isActive: true,
    });
  });
});

describe('validateVipTierForm', () => {
  it('accepts a valid tier form', () => {
    const result = validateVipTierForm(
      makeTierForm({ description: ' reserve slot ', defaultDays: '30', sortOrder: '10' }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'VIP Bronze',
        role_id: 'role-1',
        description: 'reserve slot',
        default_days: 30,
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
    }
  });

  it('rejects empty name', () => {
    const result = validateVipTierForm(makeTierForm({ name: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects a missing role', () => {
    const result = validateVipTierForm(makeTierForm({ roleId: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.roleId).toBeTruthy();
  });

  it('rejects default_days out of range', () => {
    const tooLow = validateVipTierForm(makeTierForm({ defaultDays: '0' }));
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.errors.defaultDays).toBeTruthy();

    const tooHigh = validateVipTierForm(makeTierForm({ defaultDays: '3651' }));
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.errors.defaultDays).toBeTruthy();

    const fractional = validateVipTierForm(makeTierForm({ defaultDays: '1.5' }));
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.errors.defaultDays).toBeTruthy();
  });

  it('rejects negative sort_order', () => {
    const result = validateVipTierForm(makeTierForm({ sortOrder: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.sortOrder).toBeTruthy();
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
    expect(formatUpdatedAt('2026-07-05T00:00:00.000Z')).not.toBe('ещё не сохранялись');
  });
});
