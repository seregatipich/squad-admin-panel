export const PLAYER_LINK_TYPES = ['alt', 'family_share', 'same_household', 'unrelated'] as const;
export type PlayerLinkType = (typeof PLAYER_LINK_TYPES)[number];

export const PLAYER_LINK_STATUSES = ['confirmed', 'rejected'] as const;
export type PlayerLinkStatus = (typeof PLAYER_LINK_STATUSES)[number];

export const LINK_TYPE_LABELS_RU: Record<PlayerLinkType, string> = {
  alt: 'Альт',
  family_share: 'Family Share',
  same_household: 'Общий дом',
  unrelated: 'Не связаны',
};

export interface PlayerLinkOtherPlayer {
  id: string;
  current_name: string;
  steam_id64: string | null;
}

export interface PlayerLinkCreatedBy {
  player_id: string;
  name: string;
}

/** A confirmed/rejected `player_links` row, from the viewpoint of one side of the pair. */
export interface PlayerLink {
  id: string;
  link_type: PlayerLinkType;
  status: PlayerLinkStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
  created_by: PlayerLinkCreatedBy | null;
  other_player: PlayerLinkOtherPlayer | null;
}

/** The ALT-2 verdict annotation ALT-1 attaches to a candidate row (or `null` if undecided). */
export interface CandidateLinkAnnotation {
  id: string;
  link_type: PlayerLinkType;
  status: PlayerLinkStatus;
  note: string | null;
  decided_by_name: string | null;
  decided_at: string;
}

export interface AltCandidateSignal<T> {
  value: T;
  weight: number;
}

/** One row of the ALT-1 candidate engine response (`GET .../alt-candidates`). */
export interface AltCandidate {
  player_id: string;
  current_name: string | null;
  steam_id64: string | null;
  shared_ip_count: number;
  ignored_shared_ip_count: number;
  min_time_delta_seconds: number | null;
  score: number;
  confidence: 'low' | 'medium' | 'high';
  has_active_ban: boolean;
  has_permanent_ban: boolean;
  signals: {
    shared_ips: AltCandidateSignal<number>;
    shared_names: AltCandidateSignal<string[]>;
    young_account: AltCandidateSignal<boolean>;
    steamid_proximity: AltCandidateSignal<boolean>;
  };
  link: CandidateLinkAnnotation | null;
}

/**
 * Splits the full ALT-1 candidate list into the "unresolved" (undecided, or
 * confirmed) set shown as active and the "rejected" set — pairs the admin
 * already dismissed, kept visible but collapsed/marked rather than dropped
 * (AC: rejected pairs stay in the full ALT-1 output, just not among the
 * "possible alts" an admin still needs to act on).
 */
export function splitCandidates(candidates: AltCandidate[]): {
  unresolved: AltCandidate[];
  rejected: AltCandidate[];
} {
  const unresolved: AltCandidate[] = [];
  const rejected: AltCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.link?.status === 'rejected') {
      rejected.push(candidate);
    } else {
      unresolved.push(candidate);
    }
  }
  return { unresolved, rejected };
}

function formatDecisionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Renders the "отклонено админом N дата" mark for a rejected candidate/link. */
export function formatRejectedMark(link: CandidateLinkAnnotation): string {
  const name = link.decided_by_name ?? 'неизвестным админом';
  return `Отклонено админом ${name} ${formatDecisionDate(link.decided_at)}`;
}

/**
 * Builds the POST /players/:id/links request body for confirming/rejecting
 * a candidate, snapshotting the ALT-1 signals already fetched into
 * `evidence_snapshot` so the decision stays auditable even if the candidate
 * later scores differently (e.g. new IP history, tuned weights).
 */
export function buildLinkPayload(
  otherPlayerId: string,
  linkType: PlayerLinkType,
  status: PlayerLinkStatus,
  note: string,
  candidate: AltCandidate,
): {
  other_player_id: string;
  link_type: PlayerLinkType;
  status: PlayerLinkStatus;
  note?: string;
  evidence_snapshot: Record<string, unknown>;
} {
  const trimmedNote = note.trim();
  return {
    other_player_id: otherPlayerId,
    link_type: linkType,
    status,
    ...(trimmedNote ? { note: trimmedNote } : {}),
    evidence_snapshot: {
      score: candidate.score,
      confidence: candidate.confidence,
      shared_ip_count: candidate.shared_ip_count,
      shared_names: candidate.signals.shared_names.value,
      signals: candidate.signals,
    },
  };
}
