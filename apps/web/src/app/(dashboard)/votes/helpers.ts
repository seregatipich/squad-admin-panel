export const PAGE_LIMIT = 50;

export type OrderDir = 'asc' | 'desc';
export type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | '30days' | 'all' | 'custom';
export type VoteType = 'map_skip' | 'map_change' | 'admin';
export type VoteResult = 'passed' | 'failed' | 'cancelled';
export type ResultTone = 'passed' | 'failed' | 'cancelled' | 'pending';

export interface VoteListItem {
  id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  initiator_player_id: string | null;
  initiator_nickname: string | null;
  vote_type: string;
  map_current: string | null;
  map_next: string | null;
  map_target: string | null;
  votes_collected: number;
  votes_required: number;
  result: string | null;
  duration_seconds: number | null;
  started_at: string;
  ended_at: string | null;
  ballot_count: number;
}

export interface VoteBallot {
  player_id: string;
  nickname: string;
  choice: 'yes' | 'no';
  voted_at: string;
}

export interface VoteDetail extends VoteListItem {
  ballots: VoteBallot[];
}

export interface VoteListResponse {
  items: VoteListItem[];
  next_cursor: string | null;
  limit: number;
}

export interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

export interface VoteFilters {
  servers: string[];
  voteType: '' | VoteType;
  result: '' | VoteResult;
  initiatorQuery: string;
  preset: DatePreset;
  from: string;
  to: string;
  order: OrderDir;
}

export const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: '30days', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
  { value: 'custom', label: 'Произвольно' },
];

export const VOTE_TYPE_OPTIONS: Array<{ value: VoteType; label: string }> = [
  { value: 'map_skip', label: 'Скип карты' },
  { value: 'map_change', label: 'Смена карты' },
  { value: 'admin', label: 'Админ' },
];

export const RESULT_OPTIONS: Array<{ value: VoteResult; label: string }> = [
  { value: 'passed', label: 'Принято' },
  { value: 'failed', label: 'Отклонено' },
  { value: 'cancelled', label: 'Отменено' },
];

const PRESET_VALUES = new Set<DatePreset>([
  'today',
  'yesterday',
  'week',
  'month',
  '30days',
  'all',
  'custom',
]);

const VOTE_TYPE_VALUES = new Set<VoteType>(['map_skip', 'map_change', 'admin']);
const RESULT_VALUES = new Set<VoteResult>(['passed', 'failed', 'cancelled']);

interface ParamsLike {
  get(key: string): string | null;
}

function isPreset(value: string | null): value is DatePreset {
  return value !== null && PRESET_VALUES.has(value as DatePreset);
}

function isVoteType(value: string | null): value is VoteType {
  return value !== null && VOTE_TYPE_VALUES.has(value as VoteType);
}

function isResult(value: string | null): value is VoteResult {
  return value !== null && RESULT_VALUES.has(value as VoteResult);
}

export function defaultFilters(): VoteFilters {
  return {
    servers: [],
    voteType: '',
    result: '',
    initiatorQuery: '',
    preset: 'all',
    from: '',
    to: '',
    order: 'desc',
  };
}

export function parseFilters(params: ParamsLike): VoteFilters {
  const servers = (params.get('servers') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    servers,
    voteType: isVoteType(params.get('type')) ? (params.get('type') as VoteType) : '',
    result: isResult(params.get('result')) ? (params.get('result') as VoteResult) : '',
    initiatorQuery: params.get('q')?.trim() ?? '',
    preset: isPreset(params.get('preset')) ? (params.get('preset') as DatePreset) : 'all',
    from: params.get('from')?.trim() ?? '',
    to: params.get('to')?.trim() ?? '',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

export function buildQueryString(filters: VoteFilters): string {
  const params = new URLSearchParams();
  if (filters.servers.length > 0) params.set('servers', filters.servers.join(','));
  if (filters.voteType) params.set('type', filters.voteType);
  if (filters.result) params.set('result', filters.result);
  if (filters.initiatorQuery) params.set('q', filters.initiatorQuery);
  if (filters.preset !== 'all') params.set('preset', filters.preset);
  if (filters.preset === 'custom') {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (filters.order !== 'desc') params.set('order', filters.order);
  return params.toString();
}

function startOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(0, 0, 0, 0);
  return day;
}

function endOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(23, 59, 59, 999);
  return day;
}

function addDays(reference: Date, amount: number): Date {
  const shifted = new Date(reference);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DateRange {
  dateFrom?: Date;
  dateTo?: Date;
}

export function resolveDateRange(filters: VoteFilters, now: Date = new Date()): DateRange {
  switch (filters.preset) {
    case 'today':
      return { dateFrom: startOfDay(now), dateTo: now };
    case 'yesterday': {
      const from = addDays(startOfDay(now), -1);
      return { dateFrom: from, dateTo: endOfDay(from) };
    }
    case 'week':
      return { dateFrom: addDays(startOfDay(now), -6), dateTo: now };
    case 'month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { dateFrom: from, dateTo: now };
    }
    case '30days':
      return { dateFrom: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), dateTo: now };
    case 'custom': {
      const range: DateRange = {};
      const from = parseDateInput(filters.from);
      const to = parseDateInput(filters.to);
      if (from) range.dateFrom = startOfDay(from);
      if (to) range.dateTo = endOfDay(to);
      return range;
    }
    default:
      return {};
  }
}

function appendFilterParams(params: URLSearchParams, filters: VoteFilters, now: Date): void {
  for (const id of filters.servers) params.append('serverId', id);
  if (filters.voteType) params.set('voteType', filters.voteType);
  if (filters.result) params.set('result', filters.result);
  if (filters.initiatorQuery) params.set('initiatorQuery', filters.initiatorQuery);
  const range = resolveDateRange(filters, now);
  if (range.dateFrom) params.set('dateFrom', range.dateFrom.toISOString());
  if (range.dateTo) params.set('dateTo', range.dateTo.toISOString());
}

export function buildListApiQuery(
  filters: VoteFilters,
  options: { now?: Date; cursor?: string | null; limit?: number } = {},
): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, now);
  params.set('order', filters.order);
  if (options.cursor) params.set('cursor', options.cursor);
  params.set('limit', String(options.limit ?? PAGE_LIMIT));
  return params.toString();
}

export function buildCountApiQuery(filters: VoteFilters, now: Date = new Date()): string {
  const params = new URLSearchParams();
  appendFilterParams(params, filters, now);
  return params.toString();
}

export function voteTypeLabel(voteType: string): string {
  const match = VOTE_TYPE_OPTIONS.find((entry) => entry.value === voteType);
  return match ? match.label : voteType;
}

export function resultTone(result: string | null): ResultTone {
  if (result === 'passed') return 'passed';
  if (result === 'failed') return 'failed';
  if (result === 'cancelled') return 'cancelled';
  return 'pending';
}

export const RESULT_TONE_LABELS: Record<ResultTone, string> = {
  passed: 'Принято',
  failed: 'Отклонено',
  cancelled: 'Отменено',
  pending: 'В процессе',
};

export const RESULT_TONE_CLASSES: Record<ResultTone, string> = {
  passed: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  failed: 'border-red-900 bg-red-950/50 text-red-300',
  cancelled: 'border-amber-900 bg-amber-950/40 text-amber-300',
  pending: 'border-neutral-800 bg-neutral-900 text-neutral-400',
};

export function resultLabel(result: string | null): string {
  return RESULT_TONE_LABELS[resultTone(result)];
}

export function shortServerName(vote: Pick<VoteListItem, 'server_slug' | 'server_name'>): string {
  if (vote.server_slug) return vote.server_slug;
  if (vote.server_name) return vote.server_name;
  return '—';
}

export function serverOptionsFromVotes(items: VoteListItem[]): ServerOption[] {
  const seen = new Map<string, ServerOption>();
  for (const item of items) {
    if (seen.has(item.server_id)) continue;
    seen.set(item.server_id, {
      id: item.server_id,
      display_name: item.server_name,
      slug: item.server_slug,
    });
  }
  return Array.from(seen.values());
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes > 0) return `${minutes}м ${secs}с`;
  return `${secs}с`;
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

export function mapChain(
  vote: Pick<VoteListItem, 'map_current' | 'map_next' | 'map_target'>,
): string[] {
  return [vote.map_current, vote.map_next, vote.map_target].filter((entry): entry is string =>
    Boolean(entry),
  );
}

export function mergeVotePage(fresh: VoteListItem[], existing: VoteListItem[]): VoteListItem[] {
  const freshIds = new Set(fresh.map((vote) => vote.id));
  const tail = existing.filter((vote) => !freshIds.has(vote.id));
  return [...fresh, ...tail];
}

export function appendVotePage(existing: VoteListItem[], incoming: VoteListItem[]): VoteListItem[] {
  const existingIds = new Set(existing.map((vote) => vote.id));
  const additions = incoming.filter((vote) => !existingIds.has(vote.id));
  return [...existing, ...additions];
}
