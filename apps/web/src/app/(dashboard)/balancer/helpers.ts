/**
 * Pure presentation helpers for the `/balancer` review surface (GAME-2, #81).
 *
 * Every branchy decision the page makes lives here rather than in JSX, so it is
 * unit-tested directly and the component stays a thin renderer. Most
 * importantly, the diff colouring is derived *only* from the payload's `state`
 * enum — never from free text — which is what makes the green/gray/red reading
 * deterministic and reviewable.
 */

/** The colour family a diff row is rendered in. */
export type ProposalTone = 'emerald' | 'neutral' | 'red';

const STATE_TONES: Record<string, ProposalTone> = {
  on_target: 'emerald',
  no_change: 'neutral',
  should_move: 'red',
};

const TONE_ROW_CLASSES: Record<ProposalTone, string> = {
  emerald: 'border-l-2 border-emerald-600 bg-emerald-950/30',
  neutral: 'border-l-2 border-neutral-700 bg-transparent',
  red: 'border-l-2 border-red-600 bg-red-950/30',
};

const STATE_LABELS: Record<string, string> = {
  on_target: 'На нужной стороне',
  no_change: 'Без изменений',
  should_move: 'Предлагается перевод',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Новое',
  reviewed: 'Рассмотрено',
  dismissed: 'Отклонено',
  superseded: 'Устарело',
};

const DECISION_LABELS: Record<string, string> = {
  acknowledge: 'Принято к сведению',
  veto: 'Вето',
  dismiss: 'Отклонено',
};

const SUBJECT_TYPE_LABELS: Record<string, string> = {
  squad: 'Отряд',
  group: 'Группа',
  player: 'Игрок',
};

const TRIGGER_LABELS: Record<string, string> = {
  win_streak: 'Серия побед',
  ticket_diff: 'Разница тикетов',
  one_sided_rounds: 'Односторонних раундов',
};

/**
 * Maps a diff state to its colour family. An unrecognised state — the exporter
 * is free to add new ones — degrades to neutral rather than to a false alarm.
 */
export function proposalStateTone(state: string): ProposalTone {
  return STATE_TONES[state] ?? 'neutral';
}

/** Tailwind classes for a diff row, keyed strictly off {@link proposalStateTone}. */
export function proposalStateRowClass(state: string): string {
  return TONE_ROW_CLASSES[proposalStateTone(state)];
}

/** Russian label for a diff state; unknown states are echoed verbatim. */
export function proposalStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** Russian label for a snapshot's review status. */
export function proposalStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Russian label for an operator decision. */
export function decisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? decision;
}

/** Russian label for what a diff row addresses. */
export function subjectTypeLabel(subjectType: string): string {
  return SUBJECT_TYPE_LABELS[subjectType] ?? subjectType;
}

/** Renders a team number, or an em dash when the exporter omitted it. */
export function formatTeam(team: number | null | undefined): string {
  return team === null || team === undefined ? '—' : `Команда ${team}`;
}

/** One threshold the snapshot's signals reached, as returned by the API. */
export interface TriggerReasonLike {
  kind: string;
  observed: number;
  threshold: number;
}

/** Renders a triggered signal as «<название>: <значение> (порог <порог>)». */
export function triggerReasonLabel(reason: TriggerReasonLike): string {
  const label = TRIGGER_LABELS[reason.kind] ?? reason.kind;
  return `${label}: ${reason.observed} (порог ${reason.threshold})`;
}

/** Filter state of the proposal list. `serverId` empty means "every server". */
export interface BalancerFilters {
  mode: string;
  serverId: string;
  status: string;
  limit: number;
}

export const DEFAULT_BALANCER_FILTERS: BalancerFilters = {
  mode: 'squad',
  serverId: '',
  status: '',
  limit: 25,
};

/** Builds the query string for `GET /api/v1/balancer/proposals`. */
export function buildProposalsQuery(filters: BalancerFilters): string {
  const params = new URLSearchParams();
  params.set('mode', filters.mode);
  if (filters.serverId) params.set('server_id', filters.serverId);
  if (filters.status) params.set('status', filters.status);
  params.set('limit', String(filters.limit));
  return params.toString();
}

/** Per-state counts of a snapshot's diff payload, for the row summary badge. */
export interface StateCounts {
  on_target: number;
  no_change: number;
  should_move: number;
}

/** Counts diff entries per known state; unknown states are not counted. */
export function summarizeStates(entries: ReadonlyArray<{ state: string }>): StateCounts {
  const counts: StateCounts = { on_target: 0, no_change: 0, should_move: 0 };
  for (const entry of entries) {
    if (entry.state === 'on_target') counts.on_target += 1;
    else if (entry.state === 'no_change') counts.no_change += 1;
    else if (entry.state === 'should_move') counts.should_move += 1;
  }
  return counts;
}

/** Which of the page's five mutually exclusive states to render. */
export type BalancerViewState = 'loading' | 'error' | 'empty' | 'healthy' | 'imbalance';

/**
 * Picks the page state. `empty` (no upstream snapshot has ever arrived) is a
 * first-class, non-broken state: the exporter is an external dependency that
 * may simply not be wired up yet.
 */
export function balancerViewState(input: {
  loading: boolean;
  error: string | null;
  items: ReadonlyArray<{ evaluation: { triggered: boolean } }>;
}): BalancerViewState {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (input.items.length === 0) return 'empty';
  return input.items.some((item) => item.evaluation.triggered) ? 'imbalance' : 'healthy';
}
