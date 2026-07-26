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

// VIP tier catalog (VIPSUB-3, #169). Bounds mirror the server zod schema in
// apps/api/src/routes/vip-tiers.ts — keep them in sync.
export const VIP_TIER_NAME_MAX = 64;
export const VIP_TIER_DESCRIPTION_MAX = 1024;
export const VIP_TIER_DEFAULT_DAYS_MIN = 1;
export const VIP_TIER_DEFAULT_DAYS_MAX = 3650;
export const VIP_TIER_SORT_ORDER_MIN = 0;
export const VIP_TIER_SORT_ORDER_MAX = 100_000;

/** Wire shape of GET/POST/PUT `/api/v1/vip-tiers` (server `serialize()`). */
export interface VipTier {
  id: string;
  name: string;
  role_id: string;
  description: string | null;
  default_days: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** String-backed state of the tier create/edit form. */
export interface VipTierFormState {
  name: string;
  roleId: string;
  description: string;
  defaultDays: string;
  sortOrder: string;
  isActive: boolean;
}

/** Payload for POST/PUT `/api/v1/vip-tiers`. */
export interface VipTierBody {
  name: string;
  role_id: string;
  description: string | null;
  default_days: number | null;
  sort_order: number;
  is_active: boolean;
}

/** Blank form for creating a new tier (active by default, like the server). */
export function emptyTierForm(): VipTierFormState {
  return { name: '', roleId: '', description: '', defaultDays: '', sortOrder: '0', isActive: true };
}

/** Maps an API tier into the string-backed edit-form state. */
export function tierToForm(tier: VipTier): VipTierFormState {
  return {
    name: tier.name,
    roleId: tier.role_id,
    description: tier.description ?? '',
    defaultDays: tier.default_days === null ? '' : String(tier.default_days),
    sortOrder: String(tier.sort_order),
    isActive: tier.is_active,
  };
}

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (value < min || value > max) return null;
  return value;
}

export type VipTierValidation =
  | { ok: true; value: VipTierBody }
  | { ok: false; errors: Partial<Record<keyof VipTierFormState, string>> };

/**
 * Validates the tier form against the server bounds and produces the API
 * payload. Empty description/default_days map to `null` (unlimited duration).
 */
export function validateVipTierForm(form: VipTierFormState): VipTierValidation {
  const errors: Partial<Record<keyof VipTierFormState, string>> = {};

  const name = form.name.trim();
  if (name.length < 1 || name.length > VIP_TIER_NAME_MAX) {
    errors.name = `Введите название от 1 до ${VIP_TIER_NAME_MAX} символов.`;
  }
  if (form.roleId === '') {
    errors.roleId = 'Выберите роль.';
  }
  const description = form.description.trim();
  if (description.length > VIP_TIER_DESCRIPTION_MAX) {
    errors.description = `Описание не длиннее ${VIP_TIER_DESCRIPTION_MAX} символов.`;
  }
  const defaultDays =
    form.defaultDays.trim() === ''
      ? null
      : parseBoundedInt(form.defaultDays, VIP_TIER_DEFAULT_DAYS_MIN, VIP_TIER_DEFAULT_DAYS_MAX);
  if (form.defaultDays.trim() !== '' && defaultDays === null) {
    errors.defaultDays = `Введите целое число от ${VIP_TIER_DEFAULT_DAYS_MIN} до ${VIP_TIER_DEFAULT_DAYS_MAX} или оставьте поле пустым.`;
  }
  const sortOrder = parseBoundedInt(
    form.sortOrder,
    VIP_TIER_SORT_ORDER_MIN,
    VIP_TIER_SORT_ORDER_MAX,
  );
  if (sortOrder === null) {
    errors.sortOrder = `Введите целое число от ${VIP_TIER_SORT_ORDER_MIN} до ${VIP_TIER_SORT_ORDER_MAX}.`;
  }

  if (Object.keys(errors).length > 0 || sortOrder === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name,
      role_id: form.roleId,
      description: description === '' ? null : description,
      default_days: defaultDays,
      sort_order: sortOrder,
      is_active: form.isActive,
    },
  };
}

/** Renders a tier's default duration: `30 дн.` or `бессрочно` for `null`. */
export function formatTierDuration(defaultDays: number | null): string {
  return defaultDays === null ? 'бессрочно' : `${defaultDays} дн.`;
}
