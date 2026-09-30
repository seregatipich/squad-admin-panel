import { dateInputToIso } from '@/lib/format';

export const BONUS_TYPE_OPTIONS = [
  { value: 'earn_online', label: 'Онлайн' },
  { value: 'earn_boost', label: 'Буст' },
  { value: 'earn_seed', label: 'Сид' },
  { value: 'spend', label: 'Списание' },
  { value: 'adjust', label: 'Корректировка' },
] as const;

export type BonusType = (typeof BONUS_TYPE_OPTIONS)[number]['value'];

const TYPE_LABELS = new Map(BONUS_TYPE_OPTIONS.map((option) => [option.value, option.label]));

/**
 * `bonus_transactions.reference_type` values written today: the daily accrual
 * (`daily_presence`), the ECON-6 shop (`purchase`), VIP subscriptions — the
 * first charge from the API and each renewal from worker-role-expirer
 * (`vip_subscription`, #463) — and manual adjustments. An unknown value falls
 * through to the raw code rather than being hidden.
 */
const REFERENCE_LABELS: Record<string, string> = {
  daily_presence: 'Начисление за день',
  manual: 'Ручная корректировка',
  purchase: 'Покупка привилегии',
  vip_subscription: 'VIP-подписка',
};

const PAGE_SIZE = 50;

export interface BonusFilters {
  type: string;
  from: string;
  to: string;
}

export const EMPTY_BONUS_FILTERS: BonusFilters = {
  type: '',
  from: '',
  to: '',
};

export interface BonusTransaction {
  id: number;
  player_id: string;
  amount: number;
  type: string;
  reference_type: string | null;
  reference_id: string | null;
  comment: string | null;
  actor_player_id: string | null;
  created_at: string;
}

export interface BonusPage {
  items: BonusTransaction[];
  next_cursor: number | null;
}

export interface AdjustResponse {
  player_id: string;
  balance: number;
  transaction: BonusTransaction;
}

export interface PurchaseResponse {
  ok: boolean;
  balance: number;
  role_id: string;
  role_expires_at: string;
}

function asRecord(json: unknown): Record<string, unknown> | null {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
}

/** Narrows a decoded bonus-transactions page; `null` on any shape mismatch. */
export function parseBonusPage(json: unknown): BonusPage | null {
  const value = asRecord(json);
  if (!value || !Array.isArray(value.items)) return null;
  const cursor = value.next_cursor;
  if (cursor !== null && typeof cursor !== 'number') return null;
  return { items: value.items as BonusTransaction[], next_cursor: cursor };
}

/** Extracts the numeric balance from a bonus-balance body; `null` on mismatch. */
export function parseBalance(json: unknown): number | null {
  const value = asRecord(json);
  return value && typeof value.balance === 'number' ? value.balance : null;
}

/** Extracts the tier list from a bonus-shop body; `null` on mismatch. */
export function parseShopTiers(json: unknown): ShopTier[] | null {
  const value = asRecord(json);
  return value && Array.isArray(value.tiers) ? (value.tiers as ShopTier[]) : null;
}

/** Narrows a bonus adjustment response; `null` on any shape mismatch. */
export function parseAdjustResponse(json: unknown): AdjustResponse | null {
  const value = asRecord(json);
  if (!value || typeof value.balance !== 'number' || !asRecord(value.transaction)) return null;
  return value as unknown as AdjustResponse;
}

/** Narrows a bonus purchase response; `null` on any shape mismatch. */
export function parsePurchaseResponse(json: unknown): PurchaseResponse | null {
  const value = asRecord(json);
  if (!value || typeof value.ok !== 'boolean' || typeof value.balance !== 'number') return null;
  return value as unknown as PurchaseResponse;
}

export function buildBonusQuery(
  filters: BonusFilters,
  cursor?: number | null,
  limit: number = PAGE_SIZE,
): string {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  const fromIso = dateInputToIso(filters.from, false);
  if (fromIso) params.set('from', fromIso);
  const toIso = dateInputToIso(filters.to, true);
  if (toIso) params.set('to', toIso);
  params.set('limit', String(limit));
  if (cursor != null) params.set('before', String(cursor));
  return `?${params.toString()}`;
}

export function mergeBonusPage(
  prev: BonusTransaction[],
  incoming: BonusTransaction[],
  append: boolean,
): BonusTransaction[] {
  const seen = new Set<number>();
  const base = append ? prev : [];
  for (const tx of base) seen.add(tx.id);
  const merged = append ? [...prev] : [];
  for (const tx of incoming) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    merged.push(tx);
  }
  return merged;
}

export function prependTransaction(
  prev: BonusTransaction[],
  incoming: BonusTransaction,
): BonusTransaction[] {
  if (prev.some((tx) => tx.id === incoming.id)) return prev;
  return [incoming, ...prev];
}

/**
 * Whether a freshly created transaction belongs in the currently filtered
 * table (#437) — mirrors `chat-history.ts#matchesFilters`, which the live
 * chat feed already uses for the same "only splice in a row that would
 * survive a reload" reasoning.
 */
export function matchesFilters(tx: BonusTransaction, filters: BonusFilters): boolean {
  if (filters.type && tx.type !== filters.type) return false;
  const fromIso = dateInputToIso(filters.from, false);
  if (fromIso && tx.created_at < fromIso) return false;
  const toIso = dateInputToIso(filters.to, true);
  if (toIso && tx.created_at > toIso) return false;
  return true;
}

export function typeLabel(type: string): string {
  return TYPE_LABELS.get(type as BonusType) ?? type;
}

export function isCredit(type: string): boolean {
  return type === 'earn_online' || type === 'earn_boost' || type === 'earn_seed';
}

export function sourceLabel(tx: Pick<BonusTransaction, 'reference_type' | 'reference_id'>): string {
  if (!tx.reference_type) return '—';
  const label = REFERENCE_LABELS[tx.reference_type] ?? tx.reference_type;
  return tx.reference_id ? `${label} · ${tx.reference_id}` : label;
}

export function formatAmount(amount: number): string {
  return amount > 0 ? `+${amount}` : String(amount);
}

/** Purchasable tier as served by `GET /api/v1/bonus-shop/tiers` (ECON-6). */
export interface ShopTier {
  id: string;
  name: string;
  role_id: string;
  description: string | null;
  default_days: number | null;
  sort_order: number;
  is_active: boolean;
  price_bonuses: number | null;
}

export function canAfford(balance: number | null, price: number | null | undefined): boolean {
  if (balance == null || price == null) return false;
  return balance >= price;
}

const PURCHASE_ERROR_TEXT: Record<string, string> = {
  economy_disabled: 'Экономика отключена в настройках.',
  tier_not_found: 'Привилегия не найдена — обновите список.',
  tier_not_purchasable: 'Привилегия отключена или у неё не задана цена — покупка недоступна.',
  role_grants_panel_access: 'Роль привилегии даёт доступ к панели — покупка запрещена.',
  insufficient_balance: 'Недостаточно бонусов для покупки.',
  role_permanent: 'У игрока бессрочная роль — покупка не требуется.',
  role_conflict: 'У игрока уже есть другая роль. Сначала снимите её.',
  player_not_found: 'Игрок не найден.',
  already_subscribed: 'У игрока уже есть активная VIP-подписка.',
  subscription_not_found: 'Подписка не найдена — обновите список.',
  forbidden: 'Недостаточно прав: нужны can_manage_economy и can_assign_roles.',
};

/**
 * Russian text for an error code of the bonus-shop purchase and the VIP
 * subscription grant routes, which share the tier/ledger guards.
 */
export function purchaseErrorText(code: string): string {
  return PURCHASE_ERROR_TEXT[code] ?? `Ошибка: ${code}`;
}

export interface AdjustValidation {
  amount: number;
  comment: string;
}

export function validateAdjust(amountRaw: string, comment: string): AdjustValidation | string {
  const trimmed = amountRaw.trim();
  if (!trimmed) return 'Укажите сумму корректировки.';
  const amount = Number(trimmed);
  if (!Number.isInteger(amount)) return 'Сумма должна быть целым числом.';
  if (amount === 0) return 'Сумма не может быть нулевой.';
  const trimmedComment = comment.trim();
  if (!trimmedComment) return 'Комментарий обязателен.';
  if (trimmedComment.length > 512) return 'Комментарий не длиннее 512 символов.';
  return { amount, comment: trimmedComment };
}
