import type { IssueComment, IssueState, IssueView } from '@/lib/live-bus';

export const TITLE_MAX = 200;
export const BODY_MAX = 4000;
export const MAX_LABELS = 20;
export const PER_PAGE = 20;

export interface IssueFilters {
  state: '' | IssueState;
  label: string;
  assignee: string;
  q: string;
  page: number;
}

export const STATE_LABELS: Record<IssueState, string> = {
  open: 'Открыт',
  in_progress: 'В работе',
  closed: 'Закрыт',
};

export const STATE_BADGE_CLASSES: Record<IssueState, string> = {
  open: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  in_progress: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  closed: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

export const STATE_FILTERS: Array<{ value: '' | IssueState; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'open', label: 'Открытые' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'closed', label: 'Закрытые' },
];

function isIssueState(value: string | null): value is IssueState {
  return value === 'open' || value === 'in_progress' || value === 'closed';
}

interface ParamsLike {
  get(key: string): string | null;
}

export function parseFilters(params: ParamsLike): IssueFilters {
  const stateRaw = params.get('state');
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    state: isIssueState(stateRaw) ? stateRaw : '',
    label: params.get('label')?.trim() ?? '',
    assignee: params.get('assignee')?.trim() ?? '',
    q: params.get('q')?.trim() ?? '',
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

export function buildQueryString(filters: IssueFilters): string {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.label) params.set('label', filters.label);
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.q) params.set('q', filters.q);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

export function buildApiQuery(filters: IssueFilters, perPage: number = PER_PAGE): string {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.label) params.set('label', filters.label);
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.q) params.set('q', filters.q);
  params.set('page', String(filters.page));
  params.set('per_page', String(perPage));
  return params.toString();
}

export function totalPages(total: number, perPage: number = PER_PAGE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / perPage);
}

export interface CreateFormInput {
  title: string;
  body: string;
  labelCount: number;
}

export function validateCreateForm(
  input: CreateFormInput,
): { ok: true } | { ok: false; error: string } {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) return { ok: false, error: 'Введите заголовок тикета.' };
  if (title.length > TITLE_MAX)
    return { ok: false, error: `Заголовок длиннее ${TITLE_MAX} символов.` };
  if (!body) return { ok: false, error: 'Введите описание тикета.' };
  if (body.length > BODY_MAX) return { ok: false, error: `Описание длиннее ${BODY_MAX} символов.` };
  if (input.labelCount > MAX_LABELS) return { ok: false, error: `Не более ${MAX_LABELS} меток.` };
  return { ok: true };
}

export function issueMatchesFilters(issue: IssueView, filters: IssueFilters): boolean {
  if (filters.state && issue.state !== filters.state) return false;
  if (filters.assignee && issue.assignee_player_id !== filters.assignee) return false;
  if (filters.label && !issue.labels.some((label) => label.name === filters.label)) return false;
  return true;
}

export function upsertIssue(list: IssueView[], incoming: IssueView): IssueView[] {
  const index = list.findIndex((issue) => issue.id === incoming.id);
  if (index === -1) return [incoming, ...list];
  const next = list.slice();
  next[index] = incoming;
  return next;
}

export function removeIssue(list: IssueView[], id: string): IssueView[] {
  return list.filter((issue) => issue.id !== id);
}

export function appendComment(list: IssueComment[], incoming: IssueComment): IssueComment[] {
  if (list.some((comment) => comment.id === incoming.id)) return list;
  return [...list, incoming];
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU');
}

export function authorLabel(ref: { id: string; name: string } | null, fallbackId: string): string {
  if (ref) return ref.name;
  return `${fallbackId.slice(0, 8)}…`;
}
