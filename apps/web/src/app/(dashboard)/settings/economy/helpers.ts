export const COEFFICIENT_MIN = 0;
export const COEFFICIENT_MAX = 1000;
export const SEED_THRESHOLD_MIN = 0;
export const SEED_THRESHOLD_MAX = 100;

export interface PrivilegeCost {
  days: number;
  price: number;
}

export type PrivilegeCostCatalog = Record<string, PrivilegeCost>;

export interface EconomySettings {
  k_online: number;
  k_boost: number;
  k_seed: number;
  seed_threshold: number;
  economy_enabled: boolean;
  privilege_costs: PrivilegeCostCatalog;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

export interface EconomyFormState {
  kOnline: string;
  kBoost: string;
  kSeed: string;
  seedThreshold: string;
  economyEnabled: boolean;
}

export interface EconomyPutBody {
  k_online: number;
  k_boost: number;
  k_seed: number;
  seed_threshold: number;
  economy_enabled: boolean;
}

export const COEFFICIENT_FIELDS: Array<{
  key: 'kOnline' | 'kBoost' | 'kSeed';
  apiKey: 'k_online' | 'k_boost' | 'k_seed';
  label: string;
  hint: string;
}> = [
  {
    key: 'kOnline',
    apiKey: 'k_online',
    label: 'Коэффициент онлайна (k_online)',
    hint: 'Бонусы за час обычного онлайна на сервере.',
  },
  {
    key: 'kBoost',
    apiKey: 'k_boost',
    label: 'Коэффициент буста (k_boost)',
    hint: 'Бонусы за час с активным бустом сервера.',
  },
  {
    key: 'kSeed',
    apiKey: 'k_seed',
    label: 'Коэффициент сида (k_seed)',
    hint: 'Бонусы за час сид-онлайна (пустой сервер).',
  },
];

export function settingsToForm(settings: EconomySettings): EconomyFormState {
  return {
    kOnline: String(settings.k_online),
    kBoost: String(settings.k_boost),
    kSeed: String(settings.k_seed),
    seedThreshold: String(settings.seed_threshold),
    economyEnabled: settings.economy_enabled,
  };
}

function parseCoefficient(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (value < COEFFICIENT_MIN || value > COEFFICIENT_MAX) return null;
  return value;
}

function parseSeedThreshold(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (value < SEED_THRESHOLD_MIN || value > SEED_THRESHOLD_MAX) return null;
  return value;
}

export type EconomyValidation =
  | { ok: true; value: EconomyPutBody }
  | { ok: false; errors: Partial<Record<keyof EconomyFormState, string>> };

export function validateEconomyForm(form: EconomyFormState): EconomyValidation {
  const errors: Partial<Record<keyof EconomyFormState, string>> = {};
  const kOnline = parseCoefficient(form.kOnline);
  const kBoost = parseCoefficient(form.kBoost);
  const kSeed = parseCoefficient(form.kSeed);
  const seedThreshold = parseSeedThreshold(form.seedThreshold);

  const coefficientError = `Введите число от ${COEFFICIENT_MIN} до ${COEFFICIENT_MAX}.`;
  if (kOnline === null) errors.kOnline = coefficientError;
  if (kBoost === null) errors.kBoost = coefficientError;
  if (kSeed === null) errors.kSeed = coefficientError;
  if (seedThreshold === null) {
    errors.seedThreshold = `Введите целое число от ${SEED_THRESHOLD_MIN} до ${SEED_THRESHOLD_MAX}.`;
  }

  if (kOnline === null || kBoost === null || kSeed === null || seedThreshold === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      k_online: kOnline,
      k_boost: kBoost,
      k_seed: kSeed,
      seed_threshold: seedThreshold,
      economy_enabled: form.economyEnabled,
    },
  };
}

export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return 'ещё не сохранялись';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ещё не сохранялись';
  return date.toLocaleString('ru-RU');
}
