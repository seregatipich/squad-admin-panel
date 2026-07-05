export const BONUS_TYPE_OPTIONS = [
  { value: 'earn_online', label: 'Онлайн' },
  { value: 'earn_boost', label: 'Буст' },
  { value: 'earn_seed', label: 'Сид' },
  { value: 'spend', label: 'Списание' },
  { value: 'adjust', label: 'Корректировка' },
] as const;

export type BonusType = (typeof BONUS_TYPE_OPTIONS)[number]['value'];

const TYPE_LABELS = new Map(BONUS_TYPE_OPTIONS.map((option) => [option.value, option.label]));

const REFERENCE_LABELS: Record<string, string> = {
  daily_presence: 'Начисление за день',
  manual: 'Ручная корректировка',
  purchase: 'Покупка привилегии',
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

export function dateInputToIso(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const parsed = new Date(`${value}${suffix}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

export function formatBonusTs(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
