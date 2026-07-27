/** Media evidence attached to a moderation action, as served in `evidence[]`. */
export interface ModerationEvidence {
  id: string;
  kind: 'video' | 'image' | 'external_link';
  external_url: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  title: string | null;
  linked_by_player_id: string | null;
  linked_at: string;
}

export type ModerationAuthor =
  | { kind: 'player'; id: string; name: string | null }
  | { kind: 'system'; label: string | null };

/** One row of `GET /api/v1/players/:playerId/moderation-actions`. */
export interface ModerationHistoryAction {
  id: string;
  action_type: string;
  reason: string | null;
  created_at: string;
  reverted_at: string | null;
  server: { id: string; name: string | null } | null;
  author: ModerationAuthor;
  evidence: ModerationEvidence[];
  evidence_count: number;
}

/**
 * `moderation_actions.action_type` is free text with no CHECK constraint —
 * these are the values actually written today (the panel's own warn/kick/ban/
 * unban, plus the banname, external-ban and clan-guard workers). Anything else
 * falls through to the raw value rather than being hidden behind a placeholder.
 */
const ACTION_LABELS: Record<string, string> = {
  warn: 'Предупреждение',
  kick: 'Кик',
  ban: 'Бан',
  unban: 'Разбан',
  name_kick: 'Кик за ник',
  external_ban_kick: 'Кик по внешнему бану',
  'external_ban.local_ban': 'Локальный бан по внешнему',
  clan_tag_protection: 'Защита клан-тега',
};

const NEUTRAL_BADGE = 'bg-neutral-800 text-neutral-300 border border-neutral-700';

const ACTION_BADGE_CLASSES: Record<string, string> = {
  warn: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  kick: 'bg-orange-950/50 text-orange-300 border border-orange-900',
  ban: 'bg-red-950/50 text-red-300 border border-red-900',
  unban: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  name_kick: 'bg-orange-950/50 text-orange-300 border border-orange-900',
  external_ban_kick: 'bg-orange-950/50 text-orange-300 border border-orange-900',
  'external_ban.local_ban': 'bg-red-950/50 text-red-300 border border-red-900',
  clan_tag_protection: 'bg-sky-950/50 text-sky-300 border border-sky-900',
};

export function moderationActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

export function moderationActionBadgeClass(actionType: string): string {
  return ACTION_BADGE_CLASSES[actionType] ?? NEUTRAL_BADGE;
}

export function formatModerationDate(iso: string | null): string {
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

/** Renders the action's author — a panel user's name, or the worker's system label. */
export function authorLabel(author: ModerationAuthor): string {
  if (author.kind === 'player') return author.name ?? 'Неизвестный модератор';
  return author.label ?? 'Система';
}

export function evidenceLabel(item: ModerationEvidence): string {
  return item.title ?? item.original_filename;
}

export function mediaStreamUrl(mediaId: string): string {
  return `/api/v1/media/${mediaId}/stream`;
}

export function detachEvidenceUrl(mediaId: string, actionId: string): string {
  return `/api/v1/media/${mediaId}/links?entity_type=moderation_action&entity_id=${actionId}`;
}

/**
 * Whether to offer «Открепить» on an evidence link.
 *
 * `DELETE /api/v1/media/:id/links` accepts your own link unconditionally and
 * someone else's only with the `can_manage_media` role flag — but that flag is
 * not on `GET /api/v1/me`, which is frozen for this batch, so the panel cannot
 * know it client-side. Offering the button only on your own link is therefore
 * the conservative choice: it never renders an action the server will refuse.
 * A `can_manage_media` holder can still detach through the API, and this
 * predicate is the single place to widen once `/api/v1/me` exposes the flag.
 */
export function canDetachEvidence(
  linkedByPlayerId: string | null,
  viewerPlayerId: string | null,
): boolean {
  if (!linkedByPlayerId || !viewerPlayerId) return false;
  return linkedByPlayerId === viewerPlayerId;
}
