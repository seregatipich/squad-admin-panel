export const PAGE_LIMIT = 50;

export type SortField = 'started_at' | 'duration_seconds' | 'layer';
export type OrderDir = 'asc' | 'desc';
export type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | '30days' | 'all' | 'custom';
export type MatchWinner = 'team1' | 'team2' | 'draw' | null;
export type PillTone = 'winner' | 'loser' | 'neutral';

export interface MatchListItem {
  id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  layer: string | null;
  map: string | null;
  game_mode: string | null;
  team1_faction: string | null;
  team2_faction: string | null;
  team1_tickets: number | null;
  team2_tickets: number | null;
  winner: MatchWinner;
  is_seed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  end_reason: string | null;
}

export interface MatchCombatStats {
  kills: number | null;
  deaths: number | null;
  teamkills: number | null;
  wounds: number | null;
  revives: number | null;
}

export interface MatchRosterEntry extends MatchCombatStats {
  player_id: string;
  nickname: string;
  team: number | null;
  squad_name: string | null;
  play_seconds: number;
}

export type MatchRosterSortField = 'player' | 'squad' | 'time' | 'kd' | 'tk' | 'wounds' | 'revives';

export interface MatchRosterSort {
  field: MatchRosterSortField;
  order: OrderDir;
}

export interface MatchTeamAggregate extends MatchCombatStats {
  players: number;
  play_seconds: number;
}

export interface MatchTimelinePlayer {
  player_id: string;
  current_name: string | null;
}

export interface MatchTimelineEvent {
  id: number;
  event_type: string;
  occurred_at: string;
  weapon: string | null;
  damage: string | null;
  attacker_kit: string | null;
  victim_vehicle: string | null;
  attacker_vehicle: string | null;
  is_teamkill: boolean;
  attacker: MatchTimelinePlayer | null;
  victim: MatchTimelinePlayer | null;
}

export interface AdjacentMatch {
  id: string;
  layer: string | null;
  started_at: string;
}

export interface MatchDetail extends MatchListItem {
  roster: MatchRosterEntry[];
  teams: {
    team1: MatchTeamAggregate;
    team2: MatchTeamAggregate;
  };
  previous_match: AdjacentMatch | null;
  next_match: AdjacentMatch | null;
  combat_events: MatchTimelineEvent[] | null;
}

export interface MatchListResponse {
  items: MatchListItem[];
  next_cursor: string | null;
  limit: number;
}

export interface MatchListScrollSnapshot {
  href: string;
  matchId: string;
  savedAt: number;
  scrollY: number;
}

export interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

export interface MatchFilters {
  layer: string;
  servers: string[];
  preset: DatePreset;
  from: string;
  to: string;
  hideSeeding: boolean;
  sort: SortField;
  order: OrderDir;
  playerId: string;
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

export const SORT_COLUMNS: Array<{ value: SortField; label: string }> = [
  { value: 'started_at', label: 'Начало' },
  { value: 'duration_seconds', label: 'Длительность' },
  { value: 'layer', label: 'Layer' },
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

const SORT_VALUES = new Set<SortField>(['started_at', 'duration_seconds', 'layer']);

interface ParamsLike {
  get(key: string): string | null;
}

function isPreset(value: string | null): value is DatePreset {
  return value !== null && PRESET_VALUES.has(value as DatePreset);
}

function isSortField(value: string | null): value is SortField {
  return value !== null && SORT_VALUES.has(value as SortField);
}

export function defaultFilters(): MatchFilters {
  return {
    layer: '',
    servers: [],
    preset: 'all',
    from: '',
    to: '',
    hideSeeding: true,
    sort: 'started_at',
    order: 'desc',
    playerId: '',
  };
}

export function parseFilters(params: ParamsLike): MatchFilters {
  const servers = (params.get('servers') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    layer: params.get('layer')?.trim() ?? '',
    servers,
    preset: isPreset(params.get('preset')) ? (params.get('preset') as DatePreset) : 'all',
    from: params.get('from')?.trim() ?? '',
    to: params.get('to')?.trim() ?? '',
    hideSeeding: params.get('seeding') !== 'show',
    sort: isSortField(params.get('sort')) ? (params.get('sort') as SortField) : 'started_at',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    playerId: params.get('player')?.trim() ?? '',
  };
}

export function buildQueryString(filters: MatchFilters): string {
  const params = new URLSearchParams();
  if (filters.layer) params.set('layer', filters.layer);
  if (filters.servers.length > 0) params.set('servers', filters.servers.join(','));
  if (filters.preset !== 'all') params.set('preset', filters.preset);
  if (filters.preset === 'custom') {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (!filters.hideSeeding) params.set('seeding', 'show');
  if (filters.sort !== 'started_at') params.set('sort', filters.sort);
  if (filters.order !== 'desc') params.set('order', filters.order);
  if (filters.playerId) params.set('player', filters.playerId);
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

export function resolveDateRange(filters: MatchFilters, now: Date = new Date()): DateRange {
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

function appendFilterParams(params: URLSearchParams, filters: MatchFilters, now: Date): void {
  if (filters.layer) params.set('layer', filters.layer);
  for (const id of filters.servers) params.append('serverIds', id);
  const range = resolveDateRange(filters, now);
  if (range.dateFrom) params.set('dateFrom', range.dateFrom.toISOString());
  if (range.dateTo) params.set('dateTo', range.dateTo.toISOString());
  params.set('hideSeeding', filters.hideSeeding ? 'true' : 'false');
  if (filters.playerId) params.set('playerId', filters.playerId);
}

export function buildListApiQuery(
  filters: MatchFilters,
  options: { now?: Date; cursor?: string | null; limit?: number } = {},
): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, now);
  params.set('sort', filters.sort);
  params.set('order', filters.order);
  if (options.cursor) params.set('cursor', options.cursor);
  params.set('limit', String(options.limit ?? PAGE_LIMIT));
  return params.toString();
}

export function buildCountApiQuery(filters: MatchFilters, now: Date = new Date()): string {
  const params = new URLSearchParams();
  appendFilterParams(params, filters, now);
  return params.toString();
}

export function buildExportUrl(filters: MatchFilters, now: Date = new Date()): string {
  const params = new URLSearchParams();
  appendFilterParams(params, filters, now);
  params.set('format', 'csv');
  return `/api/v1/matches/export?${params.toString()}`;
}

export function safeMatchBackHref(value: string | string[] | null | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.startsWith('//') || !raw.startsWith('/matches')) return '/matches';
  if (raw === '/matches' || raw.startsWith('/matches?') || raw.startsWith('/matches/')) return raw;
  return '/matches';
}

const MATCH_LIST_SCROLL_KEY_PREFIX = 'squad:matches:list-scroll:';
const MATCH_LIST_SCROLL_TTL_MS = 30 * 60 * 1000;
const MATCH_LIST_SCROLL_RESTORE_MARGIN_PX = 96;

function matchListScrollKey(href: string): string {
  return `${MATCH_LIST_SCROLL_KEY_PREFIX}${encodeURIComponent(href)}`;
}

export function saveMatchListScroll(
  storage: Storage,
  href: string,
  scrollY: number,
  matchId: string,
  now = Date.now(),
): boolean {
  const safeHref = safeMatchBackHref(href);
  if (safeHref !== href || !matchId || !Number.isFinite(scrollY) || scrollY < 0) return false;

  try {
    storage.setItem(
      matchListScrollKey(href),
      JSON.stringify({
        href,
        matchId,
        savedAt: now,
        scrollY: Math.round(scrollY),
      } satisfies MatchListScrollSnapshot),
    );
    return true;
  } catch {
    return false;
  }
}

export function readMatchListScroll(
  storage: Storage,
  href: string,
  now = Date.now(),
): MatchListScrollSnapshot | null {
  try {
    const raw = storage.getItem(matchListScrollKey(href));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MatchListScrollSnapshot>;
    const parsedHref = parsed.href;
    const parsedMatchId = parsed.matchId;
    const parsedSavedAt = parsed.savedAt;
    const parsedScrollY = parsed.scrollY;
    const valid =
      parsedHref === href &&
      typeof parsedMatchId === 'string' &&
      parsedMatchId.length > 0 &&
      typeof parsedSavedAt === 'number' &&
      Number.isFinite(parsedSavedAt) &&
      typeof parsedScrollY === 'number' &&
      Number.isFinite(parsedScrollY) &&
      parsedScrollY >= 0;
    if (!valid || now - parsedSavedAt > MATCH_LIST_SCROLL_TTL_MS) {
      storage.removeItem(matchListScrollKey(href));
      return null;
    }
    return {
      href: parsedHref,
      matchId: parsedMatchId,
      savedAt: parsedSavedAt,
      scrollY: parsedScrollY,
    };
  } catch {
    return null;
  }
}

export function clearMatchListScroll(storage: Storage, href: string): void {
  try {
    storage.removeItem(matchListScrollKey(href));
  } catch {}
}

export function shouldDelayMatchScrollRestore(
  targetScrollY: number,
  viewportHeight: number,
  scrollHeight: number,
  hasNextCursor: boolean,
): boolean {
  if (!hasNextCursor) return false;
  const maxVisibleScrollY = Math.max(0, scrollHeight - viewportHeight);
  return targetScrollY > maxVisibleScrollY + MATCH_LIST_SCROLL_RESTORE_MARGIN_PX;
}

export function buildMatchDetailHref(matchId: string, backHref: string = '/matches'): string {
  const safeBackHref = safeMatchBackHref(backHref);
  const backQuery = safeBackHref === '/matches' ? '' : `?from=${encodeURIComponent(safeBackHref)}`;
  return `/matches/${encodeURIComponent(matchId)}${backQuery}`;
}

export function buildMatchCombatLogHref(
  match: Pick<MatchListItem, 'server_id' | 'started_at' | 'ended_at'>,
): string {
  const params = new URLSearchParams();
  params.set('server', match.server_id);
  params.set('preset', 'custom');
  params.set('from', match.started_at.slice(0, 10));
  params.set('to', (match.ended_at ?? match.started_at).slice(0, 10));
  return `/combat-log?${params.toString()}`;
}

export function nextSort(
  current: MatchFilters,
  column: SortField,
): Pick<MatchFilters, 'sort' | 'order'> {
  if (current.sort === column) {
    return { sort: column, order: current.order === 'desc' ? 'asc' : 'desc' };
  }
  return { sort: column, order: column === 'layer' ? 'asc' : 'desc' };
}

export function teamPillTone(team: 1 | 2, winner: MatchWinner): PillTone {
  if (winner === null || winner === 'draw') return 'neutral';
  const teamKey = team === 1 ? 'team1' : 'team2';
  return winner === teamKey ? 'winner' : 'loser';
}

export const PILL_CLASSES: Record<PillTone, string> = {
  winner: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  loser: 'border-red-900 bg-red-950/50 text-red-300',
  neutral: 'border-neutral-800 bg-neutral-900 text-neutral-400',
};

export function isOpenMatch(match: Pick<MatchListItem, 'ended_at'>): boolean {
  return match.ended_at === null;
}

export function shortServerName(match: Pick<MatchListItem, 'server_slug' | 'server_name'>): string {
  if (match.server_slug) return match.server_slug;
  if (match.server_name) return match.server_name;
  return '—';
}

export function serverOptionsFromMatches(items: MatchListItem[]): ServerOption[] {
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
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${secs}с`;
  return `${secs}с`;
}

export function formatMatchStat(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

export function formatKillDeathStat(
  kills: number | null | undefined,
  deaths: number | null | undefined,
): string {
  if (kills == null && deaths == null) return '—';
  return `${formatMatchStat(kills)}/${formatMatchStat(deaths)}`;
}

function compareTextValue(
  left: string | null | undefined,
  right: string | null | undefined,
  order: OrderDir,
): number {
  const leftValue = left?.trim() ?? '';
  const rightValue = right?.trim() ?? '';
  const leftMissing = leftValue.length === 0;
  const rightMissing = rightValue.length === 0;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const result = leftValue.localeCompare(rightValue, 'ru', { numeric: true, sensitivity: 'base' });
  return order === 'asc' ? result : -result;
}

function compareNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
  order: OrderDir,
): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const result = left - right;
  return order === 'asc' ? result : -result;
}

function compareRosterFallback(left: MatchRosterEntry, right: MatchRosterEntry): number {
  return (
    compareTextValue(left.nickname, right.nickname, 'asc') ||
    left.player_id.localeCompare(right.player_id)
  );
}

export function sortMatchRosterEntries(
  entries: readonly MatchRosterEntry[],
  sort: MatchRosterSort | null,
): MatchRosterEntry[] {
  const sorted = [...entries];
  if (!sort) return sorted;

  return sorted.sort((left, right) => {
    let result = 0;
    if (sort.field === 'player')
      result = compareTextValue(left.nickname, right.nickname, sort.order);
    if (sort.field === 'squad')
      result = compareTextValue(left.squad_name, right.squad_name, sort.order);
    if (sort.field === 'time')
      result = compareNullableNumber(left.play_seconds, right.play_seconds, sort.order);
    if (sort.field === 'kd') {
      result =
        compareNullableNumber(left.kills, right.kills, sort.order) ||
        compareNullableNumber(left.deaths, right.deaths, sort.order);
    }
    if (sort.field === 'tk')
      result = compareNullableNumber(left.teamkills, right.teamkills, sort.order);
    if (sort.field === 'wounds')
      result = compareNullableNumber(left.wounds, right.wounds, sort.order);
    if (sort.field === 'revives')
      result = compareNullableNumber(left.revives, right.revives, sort.order);
    return result || compareRosterFallback(left, right);
  });
}

export function formatMatchTimelineOffset(occurredAt: string, startedAt: string): string {
  const occurred = new Date(occurredAt).getTime();
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(occurred) || Number.isNaN(started) || occurred < started) return '—';
  return `+${formatDuration(Math.floor((occurred - started) / 1000))}`;
}

export function liveDurationSeconds(startedAt: string, now: Date = new Date()): number {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
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

export function winnerLabel(match: Pick<MatchListItem, 'winner' | 'ended_at'>): string {
  if (match.ended_at === null) return '—';
  if (match.winner === 'team1') return 'Команда 1';
  if (match.winner === 'team2') return 'Команда 2';
  if (match.winner === 'draw') return 'Ничья';
  return '—';
}

export function mergeMatchPage(fresh: MatchListItem[], existing: MatchListItem[]): MatchListItem[] {
  const freshIds = new Set(fresh.map((match) => match.id));
  const tail = existing.filter((match) => !freshIds.has(match.id));
  return [...fresh, ...tail];
}

export function appendMatchPage(
  existing: MatchListItem[],
  incoming: MatchListItem[],
): MatchListItem[] {
  const existingIds = new Set(existing.map((match) => match.id));
  const additions = incoming.filter((match) => !existingIds.has(match.id));
  return [...existing, ...additions];
}
