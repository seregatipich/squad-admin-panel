export type BadgeTone = 'neutral' | 'danger' | 'warning';

export interface PriorityBadge {
  label: string;
  tone: BadgeTone;
}

const DAY_MS = 86_400_000;

/**
 * Maps a clan's `priority_expires_at` to a Russian status badge: no deadline
 * renders as «Бессрочно», a past/now deadline as «Истёк», and a future
 * deadline as «через N дн.» (rounded up so a same-day deadline still reads
 * as at least 1 day away).
 */
export function priorityBadge(
  priorityExpiresAt: string | null,
  now: Date = new Date(),
): PriorityBadge {
  if (priorityExpiresAt === null) {
    return { label: 'Бессрочно', tone: 'neutral' };
  }
  const expiresAt = new Date(priorityExpiresAt);
  const diffMs = expiresAt.getTime() - now.getTime();
  if (diffMs <= 0) {
    return { label: 'Истёк', tone: 'danger' };
  }
  const days = Math.ceil(diffMs / DAY_MS);
  return { label: `через ${days} дн.`, tone: 'warning' };
}

export interface SortableClan {
  name: string;
  member_count: number;
  priority_count: number;
}

export type ClanSortField = 'name' | 'members' | 'priority';
export type SortOrder = 'asc' | 'desc';

/** Sorts clan directory rows by name, member count, or priority-slot usage. Does not mutate the input. */
export function sortClans<T extends SortableClan>(
  items: T[],
  field: ClanSortField,
  order: SortOrder,
): T[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (field === 'name') return a.name.localeCompare(b.name, 'ru') * direction;
    if (field === 'members') return (a.member_count - b.member_count) * direction;
    return (a.priority_count - b.priority_count) * direction;
  });
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
}

/** Slices `items` into a page of `perPage` rows, clamping an out-of-range `page` into bounds. */
export function paginate<T>(items: T[], page: number, perPage = 25): PaginatedResult<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const start = (clampedPage - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: clampedPage,
    pageCount,
    total,
  };
}
