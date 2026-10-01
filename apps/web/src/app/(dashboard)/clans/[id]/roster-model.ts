export interface RosterMember {
  player_id: string;
  canonical_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  member_role: string;
  has_priority: boolean;
  reserve_from_role: boolean;
  joined_at: string;
  last_seen_at: string | null;
  online_60d_seconds: number;
}

export interface RosterResponse {
  clan_id: string;
  items: RosterMember[];
  total: number;
  page: number;
  limit: number;
  priority_count: number;
  max_priority_slots: number;
  /**
   * The viewer's own manage level, computed server-side by the same
   * `clanManageLevel` gate the mutating routes use. Never derive this from
   * searching `items` for the viewer's own row — that row can be (and, once
   * searched, sorted, or paginated, routinely is) absent from this page even
   * though the server still grants the viewer full manage rights (#509).
   */
  viewer_manage_level: 'full' | 'deputy' | null;
}

export interface PriorityErrorBody {
  error?: string;
  limit?: number;
  used?: number;
}

/**
 * Maps a `PUT .../priority` error body to a Russian message for the error
 * banner. `priority_pool_limit` includes the pool usage when the API
 * returns it; other codes fall back to a fixed message.
 */
export function priorityErrorMessage(body: PriorityErrorBody): string {
  switch (body.error) {
    case 'priority_pool_limit':
      return typeof body.used === 'number' && typeof body.limit === 'number'
        ? `Лимит пула приоритетов исчерпан (${body.used} из ${body.limit})`
        : 'Лимит пула приоритетов исчерпан';
    case 'priority_expired':
      return 'Срок приоритета клана истёк';
    case 'priority_source_conflict':
      return 'Приоритет уже предоставлен через роль игрока';
    default:
      return `Действие не выполнено: ${body.error ?? 'unknown'}`;
  }
}

export interface MeResponse {
  player_id: string;
  can_manage_clans: boolean;
}

export interface SearchCandidate {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  clan_id: string | null;
  clan_name: string | null;
}

export const ROLE_LABELS: Record<string, string> = {
  leader: 'Глава',
  deputy: 'Зам',
  member: 'Участник',
};

export const PAGE_LIMIT = 25;
export const SEARCH_MIN_CHARS = 3;
export const PRIORITY_LOCK_MS = 3000;

/** Подписи направления сортировки — часть доступного имени заголовка колонки. */
export const SORT_DIRECTION_TEXT = { asc: 'по возрастанию', desc: 'по убыванию' } as const;

export type SortField = 'name' | 'role' | 'priority' | 'joined_at' | 'last_seen' | 'online';

/**
 * Confirmation text for the "transfer leadership" dialog. The server always
 * demotes the clan's *current* leader to deputy, never the viewer — an admin
 * with `can_manage_clans` who is not themself the leader must not be told
 * that they personally will be demoted.
 */
export function transferLeadershipMessage(isViewerLeader: boolean, targetName: string): string {
  return isViewerLeader
    ? `${targetName} станет главой клана, а вы — заместителем.`
    : `${targetName} станет главой клана. Текущий глава станет заместителем.`;
}

export function memberRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function formatOnlineDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} ч`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин`;
}

/** Формат даты в колонках «Вступил» и «Был(а)»: один и тот же для обеих. */
export function formatMemberDate(iso: string | null): string {
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

export interface Capabilities {
  canAdd: boolean;
  canRemoveMembers: boolean;
  canManageFull: boolean;
  canTogglePriority: boolean;
  /** True when the viewer is themself the clan's current leader (a roster row), not merely an admin with `can_manage_clans`. */
  isLeader: boolean;
}

export function deriveCapabilities(
  me: MeResponse | null,
  viewerManageLevel: 'full' | 'deputy' | null,
): Capabilities {
  const canManageFull = Boolean(me?.can_manage_clans) || viewerManageLevel === 'full';
  const isDeputy = viewerManageLevel === 'deputy';
  // 'full' also covers a global clan manager; the leader is the viewer whose
  // full control comes from the clan itself.
  const isLeader = viewerManageLevel === 'full' && !me?.can_manage_clans;
  return {
    canManageFull,
    canAdd: canManageFull || isDeputy,
    canRemoveMembers: canManageFull || isDeputy,
    // Mirrors the API gate on PUT .../priority (clanManageLevel !== null):
    // full managers and deputies may toggle, rank-and-file members may not;
    // a deputy only for rank-and-file members (see RosterRow).
    canTogglePriority: canManageFull || isDeputy,
    isLeader,
  };
}
