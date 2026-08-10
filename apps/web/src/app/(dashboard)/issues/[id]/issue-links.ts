export const ISSUE_LINK_ENTITY_TYPES = [
  'player',
  'server',
  'moderation_action',
  'media_file',
] as const;
export type IssueLinkEntityType = (typeof ISSUE_LINK_ENTITY_TYPES)[number];

/** One ticket→entity link as `GET /api/v1/issues/:id` expands it. */
export interface IssueLinkView {
  id: string;
  issue_id: string;
  entity_type: IssueLinkEntityType;
  entity_id: string;
  /** Human-readable name of the target, or «Удалённый объект» when it is gone. */
  label: string;
  /** Where a click goes; `null` when the target no longer exists. */
  ref: string | null;
  exists: boolean;
  created_by: string | null;
  created_at: string;
}

/** The signed-in viewer, as `GET /api/v1/me` reports them. */
export interface IssueLinkViewer {
  player_id: string;
  can_manage_issues: boolean;
}

const ENTITY_TYPE_LABELS: Record<IssueLinkEntityType, string> = {
  player: 'Игрок',
  server: 'Сервер',
  moderation_action: 'Действие модерации',
  media_file: 'Медиафайл',
};

/** Russian name of a link's entity type; unknown types fall through unchanged. */
export function entityTypeLabel(type: string): string {
  return ENTITY_TYPE_LABELS[type as IssueLinkEntityType] ?? type;
}

/**
 * Mirrors the API gate on `DELETE /api/v1/issues/:id/links/:linkId`: the link's
 * own author may remove it, anyone else needs `can_manage_issues`.
 */
export function canRemoveLink(link: IssueLinkView, viewer: IssueLinkViewer | null): boolean {
  if (!viewer) return false;
  if (viewer.can_manage_issues) return true;
  return link.created_by !== null && link.created_by === viewer.player_id;
}

/** Turns a failed link mutation into the Russian message shown under the block. */
export function linkErrorMessage(status: number, error: string | undefined): string {
  if (status === 409) return 'Такая связь уже существует.';
  if (status === 422) return 'Объект не найден.';
  if (status === 403) return 'Недостаточно прав: нужно can_manage_issues.';
  if (status === 404) return 'Тикет или связь не найдены.';
  return `Не удалось выполнить действие: ${error ?? status}`;
}

/** Groups links by entity type in declaration order, alphabetically inside a group. */
export function sortLinks(links: IssueLinkView[]): IssueLinkView[] {
  return links.slice().sort((a, b) => {
    const byType =
      ISSUE_LINK_ENTITY_TYPES.indexOf(a.entity_type) -
      ISSUE_LINK_ENTITY_TYPES.indexOf(b.entity_type);
    if (byType !== 0) return byType;
    return a.label.localeCompare(b.label, 'ru');
  });
}
