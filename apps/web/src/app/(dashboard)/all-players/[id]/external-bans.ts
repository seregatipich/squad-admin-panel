export interface ExternalBanItem {
  id: string;
  nickname: string | null;
  reason: string | null;
  admin_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_active: boolean;
  is_permanent: boolean;
}

export interface ExternalBanSourceGroup {
  source: { id: string; name: string; trust_level: string; discord_url: string | null };
  bans: ExternalBanItem[];
  active_count: number;
}

export interface PlayerExternalBansResponse {
  sources: ExternalBanSourceGroup[];
  active_source_count: number;
  total: number;
}

export const TRUST_LEVEL_LABELS: Record<string, string> = {
  trusted: 'Доверенный',
  normal: 'Обычный',
  low: 'Низкий',
};

export function trustLevelLabel(level: string): string {
  return TRUST_LEVEL_LABELS[level] ?? level;
}

/**
 * Determines whether a count declines as prepositional-singular
 * («банлисте») or prepositional-plural («банлистах») in Russian: singular
 * applies only when the last digit is 1 and the last two digits aren't 11
 * (11, 111, 211… stay plural).
 */
function isSingularDeclension(n: number): boolean {
  const lastTwo = n % 100;
  const lastOne = n % 10;
  return lastOne === 1 && lastTwo !== 11;
}

/**
 * Player-card badge label for the "found in N external banlists" indicator
 * (CBAN-3, #108). n=0 renders the green "not found" phrase instead of
 * "found in 0 banlists".
 */
export function foundBadgeLabel(n: number): string {
  if (n <= 0) return 'Не найден во внешних банлистах';
  if (isSingularDeclension(n)) return `Найден в ${n} внешнем банлисте`;
  return `Найден в ${n} внешних банлистах`;
}

export interface BanStatusLike {
  is_active: boolean;
  is_permanent: boolean;
}

/**
 * Подпись статуса одного внешнего бана: перманентный, временный или снятый.
 *
 * Возвращается только текст: цвет пилюли выбирает разметка через тон `Badge`,
 * потому что оттенок в дизайн-системе — это состояние, а не строка классов,
 * которую помощник таскает за собой (§5).
 */
export function banStatusBadge(ban: BanStatusLike): { label: string } {
  if (!ban.is_active) return { label: 'Неактивен' };
  if (ban.is_permanent) return { label: 'Перманентный' };
  return { label: 'Временный' };
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
