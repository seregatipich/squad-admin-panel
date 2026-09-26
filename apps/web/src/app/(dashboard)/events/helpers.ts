export const PAGE_LIMIT = 50;

export type OrderDir = 'asc' | 'desc';
export type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | '30days' | 'all' | 'custom';

export interface EventListItem {
  event_id: string;
  server_id: string | null;
  server_name: string | null;
  server_slug: string | null;
  occurred_at: string;
  kind: string;
  version: number;
  actor_kind: string | null;
  actor_id: string | null;
  actor_nickname: string | null;
  correlation_id: string | null;
}

export interface EventEnvelope {
  event_id: string;
  version: number;
  type: string;
  server_id: string | null;
  server_name: string | null;
  server_slug: string | null;
  ts: string;
  actor: { kind: string | null; id: string | null } | null;
  actor_nickname: string | null;
  correlation_id: string | null;
  payload: unknown;
}

export interface EventListResponse {
  items: EventListItem[];
  next_cursor: string | null;
  limit: number;
}

export interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

export interface EventFilters {
  servers: string[];
  kinds: string[];
  playerQuery: string;
  /** Filters events whose payload carries this `rule_id` (BANNAME-3 «Срабатывания» link). */
  ruleId: string;
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

export const KNOWN_EVENT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'server.ready', label: 'Сервер готов' },
  { value: 'server.starting', label: 'Сервер запускается' },
  { value: 'server.running', label: 'Сервер работает' },
  { value: 'server.stopping', label: 'Сервер останавливается' },
  { value: 'server.stopped', label: 'Сервер остановлен' },
  { value: 'server.crashed', label: 'Сервер упал' },
  { value: 'server.restarted', label: 'Сервер перезапущен' },
  { value: 'player.connected', label: 'Игрок подключился' },
  { value: 'player.disconnected', label: 'Игрок отключился' },
  { value: 'player.name_changed', label: 'Смена ника' },
  { value: 'match.started', label: 'Матч начался' },
  { value: 'match.ended', label: 'Матч завершён' },
  { value: 'rcon.connected', label: 'RCON подключён' },
  { value: 'rcon.disconnected', label: 'RCON отключён' },
  { value: 'rcon.players_polled', label: 'Опрос игроков' },
  { value: 'banname.matched', label: 'Совпадение по запрещённому нику' },
];

const KIND_LABELS = new Map(KNOWN_EVENT_KINDS.map((entry) => [entry.value, entry.label]));

const PRESET_VALUES = new Set<DatePreset>([
  'today',
  'yesterday',
  'week',
  'month',
  '30days',
  'all',
  'custom',
]);

interface ParamsLike {
  get(key: string): string | null;
}

function isPreset(value: string | null): value is DatePreset {
  return value !== null && PRESET_VALUES.has(value as DatePreset);
}

function splitCsv(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function defaultFilters(): EventFilters {
  return {
    servers: [],
    kinds: [],
    playerQuery: '',
    ruleId: '',
    preset: 'all',
    from: '',
    to: '',
    order: 'desc',
  };
}

export function parseFilters(params: ParamsLike): EventFilters {
  return {
    servers: splitCsv(params.get('servers')),
    kinds: splitCsv(params.get('kinds')),
    playerQuery: params.get('q')?.trim() ?? '',
    ruleId: params.get('rule')?.trim() ?? '',
    preset: isPreset(params.get('preset')) ? (params.get('preset') as DatePreset) : 'all',
    from: params.get('from')?.trim() ?? '',
    to: params.get('to')?.trim() ?? '',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

export function buildQueryString(filters: EventFilters): string {
  const params = new URLSearchParams();
  if (filters.servers.length > 0) params.set('servers', filters.servers.join(','));
  if (filters.kinds.length > 0) params.set('kinds', filters.kinds.join(','));
  if (filters.playerQuery) params.set('q', filters.playerQuery);
  if (filters.ruleId) params.set('rule', filters.ruleId);
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

export function resolveDateRange(filters: EventFilters, now: Date = new Date()): DateRange {
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

function appendFilterParams(
  params: URLSearchParams,
  filters: EventFilters,
  lockedServerId: string | undefined,
  now: Date,
): void {
  if (lockedServerId) {
    params.append('serverId', lockedServerId);
  } else {
    for (const id of filters.servers) params.append('serverId', id);
  }
  for (const kind of filters.kinds) params.append('kind', kind);
  if (filters.playerQuery) params.set('playerQuery', filters.playerQuery);
  if (filters.ruleId) params.set('ruleId', filters.ruleId);
  const range = resolveDateRange(filters, now);
  if (range.dateFrom) params.set('dateFrom', range.dateFrom.toISOString());
  if (range.dateTo) params.set('dateTo', range.dateTo.toISOString());
}

export interface ApiQueryOptions {
  now?: Date;
  cursor?: string | null;
  limit?: number;
  lockedServerId?: string;
}

export function buildListApiQuery(filters: EventFilters, options: ApiQueryOptions = {}): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, options.lockedServerId, now);
  params.set('order', filters.order);
  if (options.cursor) params.set('cursor', options.cursor);
  params.set('limit', String(options.limit ?? PAGE_LIMIT));
  return params.toString();
}

export function buildCountApiQuery(filters: EventFilters, options: ApiQueryOptions = {}): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, options.lockedServerId, now);
  return params.toString();
}

export function buildExportApiQuery(filters: EventFilters, options: ApiQueryOptions = {}): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, options.lockedServerId, now);
  params.set('format', 'csv');
  return params.toString();
}

export function kindLabel(kind: string): string {
  return KIND_LABELS.get(kind) ?? kind;
}

export function shortServerName(
  event: Pick<EventListItem, 'server_slug' | 'server_name' | 'server_id'>,
): string {
  if (event.server_slug) return event.server_slug;
  if (event.server_name) return event.server_name;
  if (event.server_id) return event.server_id.slice(0, 8);
  return '—';
}

export function serverOptionsFromEvents(items: EventListItem[]): ServerOption[] {
  const seen = new Map<string, ServerOption>();
  for (const item of items) {
    if (!item.server_id || seen.has(item.server_id)) continue;
    seen.set(item.server_id, {
      id: item.server_id,
      display_name: item.server_name,
      slug: item.server_slug,
    });
  }
  return Array.from(seen.values());
}

export function kindOptionsFromEvents(
  items: EventListItem[],
): Array<{ value: string; label: string }> {
  const seen = new Map<string, { value: string; label: string }>();
  for (const entry of KNOWN_EVENT_KINDS) seen.set(entry.value, entry);
  for (const item of items) {
    if (!seen.has(item.kind)) seen.set(item.kind, { value: item.kind, label: item.kind });
  }
  return Array.from(seen.values());
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
    second: '2-digit',
  });
}

export function kindTone(kind: string): string {
  if (kind.startsWith('server.crashed') || kind.endsWith('.failed')) {
    return 'border-red-900 bg-red-950/50 text-red-300';
  }
  if (kind.startsWith('player.connected') || kind.startsWith('match.started')) {
    return 'border-emerald-900 bg-emerald-950/40 text-emerald-300';
  }
  if (
    kind.startsWith('player.disconnected') ||
    kind.startsWith('match.ended') ||
    kind.startsWith('banname.matched')
  ) {
    return 'border-amber-900 bg-amber-950/40 text-amber-300';
  }
  return 'border-neutral-800 bg-neutral-900 text-neutral-300';
}

export function mergeEventPage(fresh: EventListItem[], existing: EventListItem[]): EventListItem[] {
  const freshIds = new Set(fresh.map((event) => event.event_id));
  const tail = existing.filter((event) => !freshIds.has(event.event_id));
  return [...fresh, ...tail];
}

export function appendEventPage(
  existing: EventListItem[],
  incoming: EventListItem[],
): EventListItem[] {
  const existingIds = new Set(existing.map((event) => event.event_id));
  const additions = incoming.filter((event) => !existingIds.has(event.event_id));
  return [...existing, ...additions];
}

/** Payload of the `server.events.appended` live frame. */
export interface EventsAppendedBatch {
  server_id: string | null;
  kinds: string[];
}

/**
 * Whether new rows announced by `server.events.appended` can show up at the
 * top of the list the viewer has open. Lists sorted oldest-first, date windows
 * that already ended, and filters that exclude the server or every announced
 * kind are left alone, so a busy server does not make unrelated lists refetch.
 */
export function eventsBatchAffectsList(
  batch: EventsAppendedBatch,
  filters: EventFilters,
  lockedServerId?: string,
): boolean {
  if (filters.order !== 'desc') return false;
  if (filters.preset === 'yesterday') return false;
  if (filters.preset === 'custom' && filters.to) return false;
  if (lockedServerId) {
    if (batch.server_id !== lockedServerId) return false;
  } else if (filters.servers.length > 0) {
    if (!batch.server_id || !filters.servers.includes(batch.server_id)) return false;
  }
  if (filters.kinds.length > 0 && !batch.kinds.some((kind) => filters.kinds.includes(kind))) {
    return false;
  }
  return true;
}
