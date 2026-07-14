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

export const TRUST_LEVEL_BADGE_CLASSES: Record<string, string> = {
  trusted: 'border-emerald-800 bg-emerald-950/50 text-emerald-300',
  normal: 'border-sky-800 bg-sky-950/50 text-sky-300',
  low: 'border-amber-800 bg-amber-950/50 text-amber-300',
};

export function trustLevelLabel(level: string): string {
  return TRUST_LEVEL_LABELS[level] ?? level;
}

export function trustLevelBadgeClass(level: string): string {
  // biome-ignore lint/style/noNonNullAssertion: 'normal' key is always present
  return TRUST_LEVEL_BADGE_CLASSES[level] ?? TRUST_LEVEL_BADGE_CLASSES.normal!;
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

/** Status badge for a single external ban row: permanent/temporary/inactive. */
export function banStatusBadge(ban: BanStatusLike): { label: string; className: string } {
  if (!ban.is_active) {
    return {
      label: 'Неактивен',
      className: 'border-neutral-700 bg-neutral-800 text-neutral-400',
    };
  }
  if (ban.is_permanent) {
    return { label: 'Перманентный', className: 'border-red-900 bg-red-950/50 text-red-300' };
  }
  return { label: 'Временный', className: 'border-amber-900 bg-amber-950/50 text-amber-300' };
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
