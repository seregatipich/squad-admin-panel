/**
 * Pure contract + evaluation engine for the GAME-2 (#81) team balancer.
 *
 * The panel never plans a balance itself: the upstream SquadJS exporter
 * produces dry-run proposal snapshots and pushes them into the panel over the
 * inbound HMAC webhook. What lives here is everything both sides of the panel
 * need to agree on — the closed enums the database CHECKs and the API Zod
 * schemas are generated from, and the deterministic imbalance predicate the
 * API applies to a stored snapshot.
 *
 * Like `automation-engine.ts` (AUTO-1) this module performs no I/O, so the
 * same evaluation runs in an API handler today and in a worker later without a
 * second implementation drifting away from it.
 *
 * This module deliberately contains **no execution path**: #81 is review and
 * configuration only. A live team change would need a new
 * `RCON_OPERATOR_COMMANDS` entry, which a separate execute-mode issue owns.
 */

/** Granularity of a stored snapshot: whole squads/groups, or single players. */
export const BALANCER_PROPOSAL_MODES = ['squad', 'player'] as const;
export type BalancerProposalMode = (typeof BALANCER_PROPOSAL_MODES)[number];

/** What a single diff row addresses. */
export const BALANCER_SUBJECT_TYPES = ['squad', 'group', 'player'] as const;
export type BalancerSubjectType = (typeof BALANCER_SUBJECT_TYPES)[number];

/**
 * The deterministic diff state of one subject. The review UI derives its row
 * colour from this value alone (green / gray / red) — never from free text.
 */
export const BALANCER_PROPOSAL_STATES = ['on_target', 'no_change', 'should_move'] as const;
export type BalancerProposalState = (typeof BALANCER_PROPOSAL_STATES)[number];

/**
 * Review lifecycle of a stored snapshot. `superseded` is set automatically when
 * a newer snapshot arrives for the same server and mode.
 */
export const BALANCER_PROPOSAL_STATUSES = ['open', 'reviewed', 'dismissed', 'superseded'] as const;
export type BalancerProposalStatus = (typeof BALANCER_PROPOSAL_STATUSES)[number];

/** Operator decisions recorded against a snapshot. */
export const BALANCER_DECISIONS = ['acknowledge', 'veto', 'dismiss'] as const;
export type BalancerDecision = (typeof BALANCER_DECISIONS)[number];

/** Structured reason categories accompanying a `veto`. */
export const BALANCER_VETO_REASON_KINDS = ['seeding', 'event', 'clan_match', 'other'] as const;
export type BalancerVetoReasonKind = (typeof BALANCER_VETO_REASON_KINDS)[number];

/**
 * Version of the `signals` / `proposal` jsonb payload the panel writes and
 * reads. Stored per row (`balancer_proposals.schema_version`) so a change in
 * the exporter's wire format is a value change, never a migration.
 */
export const BALANCER_SCHEMA_VERSION = 1;

/** The imbalance signals the panel evaluates, in evaluation order. */
export const BALANCER_TRIGGER_KINDS = ['win_streak', 'ticket_diff', 'one_sided_rounds'] as const;
export type BalancerTriggerKind = (typeof BALANCER_TRIGGER_KINDS)[number];

/** The operator-configured trigger levels from `balancer_settings`. */
export interface BalancerThresholds {
  winStreakThreshold: number;
  ticketDiffThreshold: number;
  oneSidedRoundsThreshold: number;
}

/** Column defaults of `balancer_settings`, mirrored for callers with no row yet. */
export const DEFAULT_BALANCER_THRESHOLDS: BalancerThresholds = {
  winStreakThreshold: 3,
  ticketDiffThreshold: 150,
  oneSidedRoundsThreshold: 2,
};

/** The subset of an exporter snapshot's `signals` blob the panel evaluates. */
export interface BalancerSignals {
  winStreak?: number | null;
  ticketDiff?: number | null;
  oneSidedRounds?: number | null;
}

/** One threshold that the snapshot's signals reached or exceeded. */
export interface BalancerTriggerReason {
  kind: BalancerTriggerKind;
  observed: number;
  threshold: number;
}

/** Verdict for one snapshot: is the match imbalanced, and on which signals. */
export interface BalancerSignalEvaluation {
  triggered: boolean;
  reasons: BalancerTriggerReason[];
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads the exporter's snake_case `signals` jsonb blob into the camelCase shape
 * {@link evaluateBalancerSignals} consumes.
 *
 * Deliberately total: any field that is absent, non-numeric or non-finite
 * becomes `null` (an unevaluated signal) rather than an error, and unknown
 * extra fields are ignored. That is what lets the exporter's payload evolve
 * without breaking ingestion or forcing a migration.
 */
export function readBalancerSignals(raw: unknown): BalancerSignals {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { winStreak: null, ticketDiff: null, oneSidedRounds: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    winStreak: numeric(record.win_streak),
    ticketDiff: numeric(record.ticket_diff),
    oneSidedRounds: numeric(record.one_sided_rounds),
  };
}

/**
 * Decides whether a snapshot's signals justify a balance proposal.
 *
 * A signal triggers when its observed value reaches its threshold. The ticket
 * difference is compared by absolute value, so a blowout is detected no matter
 * which team is ahead. Absent signals never trigger, so a partial payload
 * degrades to "healthy" instead of a false alarm. Reasons are returned in
 * {@link BALANCER_TRIGGER_KINDS} order, making the result stable enough to
 * assert on and to render without re-sorting.
 */
export function evaluateBalancerSignals(
  thresholds: BalancerThresholds,
  signals: BalancerSignals,
): BalancerSignalEvaluation {
  const reasons: BalancerTriggerReason[] = [];

  const winStreak = signals.winStreak ?? null;
  if (winStreak !== null && winStreak >= thresholds.winStreakThreshold) {
    reasons.push({
      kind: 'win_streak',
      observed: winStreak,
      threshold: thresholds.winStreakThreshold,
    });
  }

  const ticketDiff = signals.ticketDiff ?? null;
  if (ticketDiff !== null && Math.abs(ticketDiff) >= thresholds.ticketDiffThreshold) {
    reasons.push({
      kind: 'ticket_diff',
      observed: Math.abs(ticketDiff),
      threshold: thresholds.ticketDiffThreshold,
    });
  }

  const oneSidedRounds = signals.oneSidedRounds ?? null;
  if (oneSidedRounds !== null && oneSidedRounds >= thresholds.oneSidedRoundsThreshold) {
    reasons.push({
      kind: 'one_sided_rounds',
      observed: oneSidedRounds,
      threshold: thresholds.oneSidedRoundsThreshold,
    });
  }

  return { triggered: reasons.length > 0, reasons };
}
