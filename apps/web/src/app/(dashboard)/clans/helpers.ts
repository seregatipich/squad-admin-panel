export type BadgeTone = 'neutral' | 'danger' | 'warning';

/** A server option for the primary-server and match-filter selects, shared by both clan pages. */
export interface ServerOption {
  id: string;
  display_name: string;
}

/** The subset of `/api/v1/me` both clan pages need to gate the "manage clans" UI. */
export interface MeResponse {
  can_manage_clans: boolean;
}

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

export type ClanSortField = 'name' | 'members' | 'priority';
export type SortOrder = 'asc' | 'desc';
