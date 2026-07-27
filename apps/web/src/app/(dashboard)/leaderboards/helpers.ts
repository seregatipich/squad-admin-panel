export const PER_PAGE = 30;

export type Metric =
  | 'online'
  | 'seeding'
  | 'kills'
  | 'deaths'
  | 'kd'
  | 'revives'
  | 'teamkills'
  | 'bonus'
  | 'boost';
export type Period = 'day' | 'week' | 'month' | 'season' | 'alltime';
export type OrderDir = 'asc' | 'desc';

export interface LeaderboardFilters {
  metric: Metric;
  period: Period;
  periodStart: string;
  serverId: string;
  search: string;
  order: OrderDir;
  page: number;
}

export interface LeaderboardRow {
  rank: number;
  player_id: string;
  current_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  metric_value: number;
  secondary: {
    online_seconds: number;
    seeding_seconds: number;
    kills: number;
    deaths: number;
    kd: number;
    matches_played: number;
    boost_seconds?: number;
    bonus_points?: number;
  };
}

export type SeasonStatus = 'upcoming' | 'active' | 'closed';

/** A named leaderboard season as returned by `GET /api/v1/seasons` (LEAD-7). */
export interface Season {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: SeasonStatus;
  finalized: boolean;
}

export interface LeaderboardBody {
  metric: string;
  period: string;
  period_start: string;
  season?: Season | null;
  server_id: string | null;
  available: boolean;
  combat_available: boolean;
  economy_enabled?: boolean;
  total_rows: number;
  total_pages: number;
  rows: LeaderboardRow[];
}

export interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

export type ColumnKey =
  | 'rank'
  | 'player'
  | 'online'
  | 'kills'
  | 'deaths'
  | 'kd'
  | 'revives'
  | 'seeding'
  | 'bonus'
  | 'boost';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  tooltip: string;
  metric: Metric | null;
  combat: boolean;
  economy: boolean;
  align: 'left' | 'right';
}

export const COLUMNS: ColumnDef[] = [
  {
    key: 'rank',
    label: '#',
    tooltip: 'Место в общем рейтинге',
    metric: null,
    combat: false,
    economy: false,
    align: 'right',
  },
  {
    key: 'player',
    label: 'Игрок',
    tooltip: 'Никнейм игрока',
    metric: null,
    combat: false,
    economy: false,
    align: 'left',
  },
  {
    key: 'online',
    label: 'Онлайн',
    tooltip: 'Суммарное время в игре',
    metric: 'online',
    combat: false,
    economy: false,
    align: 'right',
  },
  {
    key: 'kills',
    label: 'Убийства',
    tooltip: 'Количество убийств',
    metric: 'kills',
    combat: true,
    economy: false,
    align: 'right',
  },
  {
    key: 'deaths',
    label: 'Смерти',
    tooltip: 'Количество смертей',
    metric: 'deaths',
    combat: true,
    economy: false,
    align: 'right',
  },
  {
    key: 'kd',
    label: 'K/D',
    tooltip: 'Отношение убийств к смертям',
    metric: 'kd',
    combat: true,
    economy: false,
    align: 'right',
  },
  {
    key: 'revives',
    label: 'Возрождения',
    tooltip: 'Поднятия союзников',
    metric: 'revives',
    combat: true,
    economy: false,
    align: 'right',
  },
  {
    key: 'seeding',
    label: 'Сидинг',
    tooltip: 'Время на прогреве сервера',
    metric: 'seeding',
    combat: false,
    economy: false,
    align: 'right',
  },
  {
    key: 'bonus',
    label: 'Бонусы',
    tooltip: 'Начисленные бонусы (онлайн + буст + сидинг по коэффициентам экономики)',
    metric: 'bonus',
    combat: false,
    economy: true,
    align: 'right',
  },
  {
    key: 'boost',
    label: 'Буст',
    tooltip: 'Время в режиме буста',
    metric: 'boost',
    combat: false,
    economy: true,
    align: 'right',
  },
];

export const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'day', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'season', label: 'Сезон' },
  { value: 'alltime', label: 'Всё время' },
];

const METRIC_VALUES = new Set<Metric>([
  'online',
  'seeding',
  'kills',
  'deaths',
  'kd',
  'revives',
  'teamkills',
  'bonus',
  'boost',
]);
const PERIOD_VALUES = new Set<Period>(['day', 'week', 'month', 'season', 'alltime']);

const DAY_MS = 86_400_000;
const numberFmt = new Intl.NumberFormat('ru-RU');

interface ParamsLike {
  get(key: string): string | null;
}

function isMetric(value: string | null): value is Metric {
  return value !== null && METRIC_VALUES.has(value as Metric);
}

function isPeriod(value: string | null): value is Period {
  return value !== null && PERIOD_VALUES.has(value as Period);
}

function isDateString(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function isoWeekStart(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  const dow = new Date(at).getUTCDay();
  const isoOffset = dow === 0 ? 6 : dow - 1;
  return utcDayKey(new Date(at - isoOffset * DAY_MS));
}

export function currentPeriodStart(period: Period, now: Date = new Date()): string {
  const today = utcDayKey(now);
  switch (period) {
    case 'day':
      return today;
    case 'week':
      return isoWeekStart(today);
    case 'month':
      return `${today.slice(0, 7)}-01`;
    default:
      // `season` has no clock-derivable start: it is a named interval stored
      // server-side, resolved from GET /api/v1/seasons (LEAD-7, #178).
      return '';
  }
}

/**
 * Whether the period is browsed with the prev/next arrows. Seasons are not —
 * they are chosen from a list, because they are neither uniform in length nor
 * contiguous.
 */
export function canNavigatePeriod(period: Period): boolean {
  return period === 'day' || period === 'week' || period === 'month';
}

/**
 * Whether the period is keyed by a `period_start`. Broader than
 * `canNavigatePeriod`: a season carries one but is not arrow-navigable.
 */
export function periodHasStart(period: Period): boolean {
  return canNavigatePeriod(period) || period === 'season';
}

export function shiftPeriodStart(period: Period, periodStart: string, direction: 1 | -1): string {
  if (!canNavigatePeriod(period) || !isDateString(periodStart)) return periodStart;
  switch (period) {
    case 'day':
      return utcDayKey(new Date(Date.parse(`${periodStart}T00:00:00.000Z`) + direction * DAY_MS));
    case 'week':
      return utcDayKey(
        new Date(Date.parse(`${periodStart}T00:00:00.000Z`) + direction * 7 * DAY_MS),
      );
    case 'month': {
      const year = Number.parseInt(periodStart.slice(0, 4), 10);
      const month = Number.parseInt(periodStart.slice(5, 7), 10);
      const shifted = new Date(Date.UTC(year, month - 1 + direction, 1));
      return utcDayKey(shifted);
    }
    default:
      return periodStart;
  }
}

export function isFuturePeriod(
  period: Period,
  periodStart: string,
  now: Date = new Date(),
): boolean {
  if (!canNavigatePeriod(period)) return false;
  return periodStart >= currentPeriodStart(period, now);
}

export function defaultFilters(): LeaderboardFilters {
  return {
    metric: 'online',
    period: 'alltime',
    periodStart: '',
    serverId: 'all',
    search: '',
    order: 'desc',
    page: 1,
  };
}

export function parseFilters(params: ParamsLike, now: Date = new Date()): LeaderboardFilters {
  const period = isPeriod(params.get('period')) ? (params.get('period') as Period) : 'alltime';
  const rawStart = params.get('start');
  const periodStart = isDateString(rawStart)
    ? rawStart
    : canNavigatePeriod(period)
      ? currentPeriodStart(period, now)
      : '';
  const rawPage = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    metric: isMetric(params.get('metric')) ? (params.get('metric') as Metric) : 'online',
    period,
    periodStart,
    serverId: params.get('server')?.trim() || 'all',
    search: params.get('q')?.trim() ?? '',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

export function buildQueryString(filters: LeaderboardFilters): string {
  const params = new URLSearchParams();
  if (filters.metric !== 'online') params.set('metric', filters.metric);
  if (filters.period !== 'alltime') params.set('period', filters.period);
  if (filters.periodStart && periodHasStart(filters.period)) {
    params.set('start', filters.periodStart);
  }
  if (filters.serverId !== 'all') params.set('server', filters.serverId);
  if (filters.search) params.set('q', filters.search);
  if (filters.order !== 'desc') params.set('order', filters.order);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

export function buildApiQuery(filters: LeaderboardFilters): string {
  const params = new URLSearchParams();
  params.set('metric', filters.metric);
  params.set('period', filters.period);
  if (filters.periodStart && periodHasStart(filters.period)) {
    params.set('period_start', filters.periodStart);
  }
  params.set('server_id', filters.serverId);
  if (filters.search) params.set('search', filters.search);
  params.set('order', filters.order);
  params.set('per_page', String(PER_PAGE));
  params.set('page', String(filters.page));
  return params.toString();
}

export function columnMetric(column: ColumnKey): Metric | null {
  return COLUMNS.find((entry) => entry.key === column)?.metric ?? null;
}

export function nextSort(
  filters: LeaderboardFilters,
  column: ColumnKey,
): Pick<LeaderboardFilters, 'metric' | 'order' | 'page'> | null {
  const metric = columnMetric(column);
  if (!metric) return null;
  if (filters.metric === metric) {
    return { metric, order: filters.order === 'desc' ? 'asc' : 'desc', page: 1 };
  }
  return { metric, order: 'desc', page: 1 };
}

export function visibleColumns(combatAvailable: boolean, economyAvailable = false): ColumnDef[] {
  return COLUMNS.filter((column) => {
    if (column.combat && !combatAvailable) return false;
    if (column.economy && !economyAvailable) return false;
    return true;
  });
}

const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

export function medalFor(rank: number): string | null {
  return MEDALS[rank] ?? null;
}

export function shouldNavigateRow(modifiers: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  hasSelection?: boolean;
}): boolean {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey || modifiers.shiftKey) {
    return false;
  }
  if (modifiers.hasSelection) return false;
  return true;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0м';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}м`;
  return `${hours}ч ${minutes}м`;
}

export function formatMetricValue(metric: Metric, value: number): string {
  if (metric === 'online' || metric === 'seeding' || metric === 'boost')
    return formatDuration(value);
  if (metric === 'kd') return value.toFixed(2);
  return numberFmt.format(value);
}

export function formatCount(value: number): string {
  return numberFmt.format(value);
}

export function pageInfoLabel(page: number, totalPages: number, totalRows: number): string {
  return `Страница ${numberFmt.format(page)} из ${numberFmt.format(
    Math.max(1, totalPages),
  )} · Всего ${numberFmt.format(totalRows)}`;
}

export function periodRangeLabel(period: Period, periodStart: string, season?: Season): string {
  if (period === 'alltime') return 'Всё время';
  // A season is identified by its name; the calendar date it starts on is an
  // implementation detail the operator never named.
  if (period === 'season') {
    return season ? season.name : (PERIODS.find((p) => p.value === 'season')?.label ?? 'Сезон');
  }
  if (!isDateString(periodStart)) return PERIODS.find((p) => p.value === period)?.label ?? period;
  const fmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  switch (period) {
    case 'day':
      return fmt.format(start);
    case 'week': {
      const end = new Date(start.getTime() + 6 * DAY_MS);
      return `${fmt.format(start)} — ${fmt.format(end)}`;
    }
    case 'month':
      return new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(start);
    default:
      return fmt.format(start);
  }
}

// ---------------------------------------------------------------------------
// Seasons (LEAD-7, #178)
// ---------------------------------------------------------------------------

const seasonDateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * The `period_start` a season's rows are keyed by: its start day in UTC, which
 * is how the aggregator materialises them.
 */
export function seasonPeriodStart(season: Season): string {
  return season.starts_at.slice(0, 10);
}

/**
 * A closed or finalized season is history: it is offered for viewing but never
 * for editing, and the aggregator will not recompute it.
 */
export function isSeasonReadOnly(season: Season): boolean {
  return season.status === 'closed' || season.finalized;
}

export function seasonRangeLabel(season: Season): string {
  const from = seasonDateFmt.format(new Date(season.starts_at));
  const to = seasonDateFmt.format(new Date(season.ends_at));
  return `${from} — ${to}`;
}

export function seasonOptionLabel(season: Season): string {
  return isSeasonReadOnly(season) ? `${season.name} (архив)` : season.name;
}

export function findSeason(seasons: Season[], periodStart: string): Season | null {
  return seasons.find((season) => seasonPeriodStart(season) === periodStart) ?? null;
}

/** Newest first, so the running season heads the selector. */
export function sortSeasonsForSelector(seasons: Season[]): Season[] {
  return [...seasons].sort((a, b) => b.starts_at.localeCompare(a.starts_at));
}

/**
 * Which season to show when the user picks the "Сезон" chip: the running one,
 * falling back to the most recent, and to nothing at all when none exist.
 */
export function defaultSeasonPeriodStart(seasons: Season[]): string {
  const active = seasons.find((season) => season.status === 'active');
  if (active) return seasonPeriodStart(active);
  const newest = sortSeasonsForSelector(seasons)[0];
  return newest ? seasonPeriodStart(newest) : '';
}
