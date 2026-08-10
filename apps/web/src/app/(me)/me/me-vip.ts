/**
 * Pure helpers for the VIPSUB-5 self-service page. Kept out of the component
 * so the wire shapes, the money/date formatting and the error mapping are
 * testable without a DOM.
 */

export interface MeBalance {
  player_id: string;
  balance: number;
  role_id: string | null;
  role_expires_at: string | null;
}

export interface MeTier {
  tier_id: string;
  name: string;
  description: string | null;
  role_id: string;
  days: number;
  price_bonuses: number;
}

export type MeSubscriptionStatus = 'active' | 'cancelled' | 'expired';

export interface MeSubscription {
  id: string;
  player_id: string;
  tier_id: string;
  tier_name?: string;
  status: MeSubscriptionStatus;
  renews_every_days: number;
  price_bonuses: number;
  next_renewal_at: string;
  created_at: string;
  cancelled_at: string | null;
}

export interface MeBonusTransaction {
  id: number;
  amount: number;
  type: string;
  reference_type: string | null;
  comment: string | null;
  created_at: string;
}

export interface MeBonusPage {
  items: MeBonusTransaction[];
  next_cursor: number | null;
}

/** Russian labels for the subscription lifecycle. */
export const SUBSCRIPTION_STATUS_LABELS: Record<MeSubscriptionStatus, string> = {
  active: 'Активна',
  cancelled: 'Отменена',
  expired: 'Истекла',
};

/** Russian labels for the ledger entry kinds a player can see on their own page. */
export const BONUS_TYPE_LABELS: Record<string, string> = {
  earn_online: 'Онлайн',
  earn_boost: 'Буст',
  earn_seed: 'Сид',
  spend: 'Списание',
  adjust: 'Корректировка',
};

export function bonusTypeLabel(type: string): string {
  return BONUS_TYPE_LABELS[type] ?? type;
}

export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_LABELS[status as MeSubscriptionStatus] ?? status;
}

/** `+120` / `−100`, using a real minus sign so the column lines up. */
export function formatAmount(amount: number): string {
  return amount >= 0 ? `+${amount}` : `−${Math.abs(amount)}`;
}

/**
 * `дд.мм.гггг чч:мм` in the viewer's locale-independent form; `—` for a
 * missing timestamp and for an unparseable one, so a bad value never throws
 * inside a render.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Whole days left until `value`, floored at 0; `null` when there is no date. */
export function daysUntil(value: string | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

/** The single active subscription, if any — the API enforces at most one. */
export function activeSubscription(rows: MeSubscription[]): MeSubscription | null {
  return rows.find((row) => row.status === 'active') ?? null;
}

const ERROR_MESSAGES: Record<string, string> = {
  insufficient_balance: 'Недостаточно бонусов.',
  already_subscribed: 'У вас уже есть активная подписка.',
  economy_disabled: 'Экономика бонусов сейчас отключена.',
  role_conflict: 'У вас уже назначена другая роль — обратитесь к администрации.',
  role_permanent: 'У вас уже бессрочная роль этого уровня.',
  tier_not_found: 'Тариф не найден.',
  tier_not_purchasable: 'Этот тариф сейчас недоступен для покупки.',
  role_grants_panel_access: 'Этот тариф нельзя купить.',
  subscription_not_found: 'Подписка не найдена.',
  unauthenticated: 'Сессия истекла — войдите заново.',
};

/**
 * Maps an API error code to a Russian message. Unknown codes fall back to a
 * generic message with the raw code appended, so a new server-side code is
 * still actionable rather than silent.
 */
export function errorMessage(code: string | null | undefined): string {
  if (!code) return 'Не удалось выполнить операцию.';
  return ERROR_MESSAGES[code] ?? `Не удалось выполнить операцию (${code}).`;
}

/** Appends a fetched page, dropping ids already present (cursor overlap). */
export function mergeBonusPage(
  previous: MeBonusTransaction[],
  incoming: MeBonusTransaction[],
): MeBonusTransaction[] {
  const seen = new Set(previous.map((item) => item.id));
  return [...previous, ...incoming.filter((item) => !seen.has(item.id))];
}
