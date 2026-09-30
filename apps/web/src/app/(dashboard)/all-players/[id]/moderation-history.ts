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

/** Page size of the player-card moderation history; the API allows up to 200. */
export const MODERATION_HISTORY_PAGE_SIZE = 50;

/**
 * One page of `GET /api/v1/players/:playerId/moderation-actions`.
 *
 * The API has no total and no next-cursor field, so the card asks for one row
 * more than it shows: the extra row only proves another page exists (#441).
 *
 * @param playerId Player UUID; encoded, since it comes from the route segment.
 * @param cursor Id of the last row already shown, or `null` for the first page.
 */
export function moderationActionsUrl(playerId: string, cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(MODERATION_HISTORY_PAGE_SIZE + 1) });
  if (cursor) params.set('cursor', cursor);
  return `/api/v1/players/${encodeURIComponent(playerId)}/moderation-actions?${params.toString()}`;
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
  return `/api/v1/media/${encodeURIComponent(mediaId)}/stream`;
}

export function detachEvidenceUrl(mediaId: string, actionId: string): string {
  const params = new URLSearchParams({ entity_type: 'moderation_action', entity_id: actionId });
  return `/api/v1/media/${encodeURIComponent(mediaId)}/links?${params.toString()}`;
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
