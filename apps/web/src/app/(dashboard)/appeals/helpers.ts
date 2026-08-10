/**
 * Pure view helpers for the ban-appeal queue (MOD-5, #62). Kept free of React
 * so the filter/URL round-trip and the status vocabulary can be unit-tested
 * without rendering.
 */

export type AppealStatus = 'pending' | 'in_review' | 'approved' | 'rejected';

export const PAGE_SIZE = 20;
export const NOTE_MAX = 2000;

export interface AppealFilters {
  status: '' | AppealStatus;
  page: number;
}

export const STATUS_LABELS: Record<AppealStatus, string> = {
  pending: 'На рассмотрении',
  in_review: 'В работе',
  approved: 'Одобрена',
  rejected: 'Отклонена',
};

export const STATUS_BADGE_CLASSES: Record<AppealStatus, string> = {
  pending: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  in_review: 'bg-sky-950/50 text-sky-300 border border-sky-900',
  approved: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  rejected: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

export const STATUS_FILTERS: Array<{ value: '' | AppealStatus; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'pending', label: 'На рассмотрении' },
  { value: 'in_review', label: 'В работе' },
  { value: 'approved', label: 'Одобренные' },
  { value: 'rejected', label: 'Отклонённые' },
];

/**
 * The panel's copy of the API transition table (`appeals.ts`). Terminal
 * statuses map to an empty list, which is what hides the decision controls.
 */
const TRANSITIONS: Record<AppealStatus, AppealStatus[]> = {
  pending: ['in_review', 'approved', 'rejected'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

function isAppealStatus(value: string | null): value is AppealStatus {
  return (
    value === 'pending' || value === 'in_review' || value === 'approved' || value === 'rejected'
  );
}

interface ParamsLike {
  get(key: string): string | null;
}

/** Reads the queue filters out of the URL, discarding anything unrecognized. */
export function parseFilters(params: ParamsLike): AppealFilters {
  const statusRaw = params.get('status');
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    status: isAppealStatus(statusRaw) ? statusRaw : '',
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Serializes filters back into the browser URL, omitting defaults. */
export function buildQueryString(filters: AppealFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

/** Serializes filters into the `GET /api/v1/appeals` query string. */
export function buildApiQuery(filters: AppealFilters, pageSize: number = PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  params.set('page', String(filters.page));
  params.set('page_size', String(pageSize));
  return params.toString();
}

export function totalPages(total: number, pageSize: number = PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

export function formatDateTime(iso: string | null): string {
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

/** True once an appeal has been decided and can no longer change status. */
export function isTerminal(status: AppealStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** The statuses an appeal in `status` may still move to. */
export function allowedTransitions(status: AppealStatus): AppealStatus[] {
  return TRANSITIONS[status];
}

/** Human-readable queue number, e.g. `#12`. */
export function appealNumberLabel(value: number): string {
  return `#${value}`;
}
