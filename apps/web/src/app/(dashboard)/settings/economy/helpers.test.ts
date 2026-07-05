import { describe, expect, it } from 'vitest';
import {
  type EconomyFormState,
  type EconomySettings,
  formatUpdatedAt,
  settingsToForm,
  validateEconomyForm,
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
