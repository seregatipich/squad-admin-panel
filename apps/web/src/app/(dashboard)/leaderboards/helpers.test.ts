import { describe, expect, it } from 'vitest';
import {
  buildApiQuery,
  buildQueryString,
  COLUMNS,
  canNavigatePeriod,
  columnMetric,
  currentPeriodStart,
  defaultFilters,
  defaultSeasonPeriodStart,
  findSeason,
  formatDuration,
  formatMetricValue,
  isFuturePeriod,
  isoWeekStart,
  isSeasonReadOnly,
  type LeaderboardFilters,
  medalFor,
  nextSort,
  pageInfoLabel,
  parseFilters,
  periodHasStart,
  periodRangeLabel,
  type Season,
  seasonOptionLabel,
  seasonPeriodStart,
  seasonRangeLabel,
  shiftPeriodStart,
  shouldNavigateRow,
  sortSeasonsForSelector,
  visibleColumns,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function normalizeSpaces(value: string): string {
  return value.replace(/[\u00a0\u202f\u2009]/g, ' ');
}

const NOW = new Date('2026-07-05T12:00:00.000Z');

function withFilters(overrides: Partial<LeaderboardFilters> = {}): LeaderboardFilters {
  return { ...defaultFilters(), ...overrides };
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    id: 'season-1',
    name: 'Лето 2026',
    starts_at: '2026-06-01T00:00:00.000Z',
    ends_at: '2026-08-31T00:00:00.000Z',
    status: 'active',
    finalized: false,
    ...overrides,
  };
}

describe('parseFilters', () => {
  it('applies defaults for empty params', () => {
    expect(parseFilters(params(''))).toEqual(defaultFilters());
  });

  it('reads every filter from the query-string', () => {
    const filters = parseFilters(
      params('metric=kills&period=week&start=2026-06-29&server=srv-1&q=Alpha&order=asc&page=3'),
      NOW,
    );
    expect(filters).toEqual({
      metric: 'kills',
      period: 'week',
      periodStart: '2026-06-29',
      serverId: 'srv-1',
      search: 'Alpha',
      order: 'asc',
      page: 3,
    });
  });

  it('derives the current period_start for a navigable period without an explicit start', () => {
    const filters = parseFilters(params('period=day'), NOW);
    expect(filters.periodStart).toBe('2026-07-05');
  });

  it('rejects malformed metric, period, page and start', () => {
    const filters = parseFilters(params('metric=bogus&period=bogus&page=-4&start=99-99'), NOW);
    expect(filters.metric).toBe('online');
    expect(filters.period).toBe('alltime');
    expect(filters.page).toBe(1);
    expect(filters.periodStart).toBe('');
  });
});

describe('query-string round-trip', () => {
  it('omits default values so shareable links stay clean', () => {
    expect(buildQueryString(defaultFilters())).toBe('');
  });

  it('serializes then parses back to the same filters', () => {
    const original = withFilters({
      metric: 'deaths',
      period: 'month',
      periodStart: '2026-06-01',
      serverId: 'srv-9',
      search: 'bravo',
      order: 'asc',
      page: 4,
    });
    const restored = parseFilters(params(buildQueryString(original)), NOW);
    expect(restored).toEqual(original);
  });

  it('drops the period_start for non-navigable periods', () => {
    const query = buildQueryString(withFilters({ period: 'alltime', periodStart: '2026-01-01' }));
    expect(query).not.toContain('start=');
  });
});

describe('buildApiQuery', () => {
  it('always pins per_page to 30 and forwards sort order', () => {
    const query = params(
      buildApiQuery(withFilters({ metric: 'kills', order: 'asc', page: 2, serverId: 'srv-1' })),
    );
    expect(query.get('per_page')).toBe('30');
    expect(query.get('order')).toBe('asc');
    expect(query.get('page')).toBe('2');
    expect(query.get('metric')).toBe('kills');
    expect(query.get('server_id')).toBe('srv-1');
  });

  it('sends period_start only for navigable periods', () => {
    expect(
      params(buildApiQuery(withFilters({ period: 'alltime' }))).get('period_start'),
    ).toBeNull();
    const dayQuery = params(
      buildApiQuery(withFilters({ period: 'day', periodStart: '2026-07-05' })),
    );
    expect(dayQuery.get('period_start')).toBe('2026-07-05');
  });
});

describe('column → metric / sort mapping', () => {
  it('maps sortable columns to their metric and leaves rank/player unmapped', () => {
    expect(columnMetric('online')).toBe('online');
    expect(columnMetric('kd')).toBe('kd');
    expect(columnMetric('rank')).toBeNull();
    expect(columnMetric('player')).toBeNull();
  });

  it('selects a new metric descending on first click', () => {
    expect(nextSort(withFilters({ metric: 'online' }), 'kills')).toEqual({
      metric: 'kills',
      order: 'desc',
      page: 1,
    });
  });

  it('toggles order when the active metric column is clicked again', () => {
    expect(nextSort(withFilters({ metric: 'online', order: 'desc' }), 'online')).toEqual({
      metric: 'online',
      order: 'asc',
      page: 1,
    });
    expect(nextSort(withFilters({ metric: 'online', order: 'asc' }), 'online')).toEqual({
      metric: 'online',
      order: 'desc',
      page: 1,
    });
  });

  it('returns null for non-sortable columns', () => {
    expect(nextSort(withFilters(), 'rank')).toBeNull();
    expect(nextSort(withFilters(), 'player')).toBeNull();
  });
});

describe('period navigation', () => {
  it('computes the current period_start per period type', () => {
    expect(currentPeriodStart('day', NOW)).toBe('2026-07-05');
    expect(currentPeriodStart('week', NOW)).toBe(isoWeekStart('2026-07-05'));
    expect(currentPeriodStart('month', NOW)).toBe('2026-07-01');
    // LEAD-7 (#178): a season is a named interval stored server-side, so it has
    // no clock-derivable start. It used to be faked as the calendar year.
    expect(currentPeriodStart('season', NOW)).toBe('');
    expect(currentPeriodStart('alltime', NOW)).toBe('');
  });

  it('steps day/week/month backward and forward', () => {
    expect(shiftPeriodStart('day', '2026-07-05', -1)).toBe('2026-07-04');
    expect(shiftPeriodStart('day', '2026-07-05', 1)).toBe('2026-07-06');
    expect(shiftPeriodStart('week', '2026-06-29', -1)).toBe('2026-06-22');
    expect(shiftPeriodStart('month', '2026-01-01', -1)).toBe('2025-12-01');
  });

  it('never steps a season by calendar year — seasons are picked, not paged', () => {
    expect(canNavigatePeriod('season')).toBe(false);
    expect(shiftPeriodStart('season', '2026-01-01', 1)).toBe('2026-01-01');
    expect(shiftPeriodStart('season', '2026-01-01', -1)).toBe('2026-01-01');
    expect(isFuturePeriod('season', '2026-01-01', NOW)).toBe(false);
  });

  it('never navigates alltime', () => {
    expect(canNavigatePeriod('alltime')).toBe(false);
    expect(shiftPeriodStart('alltime', '', 1)).toBe('');
  });

  it('flags the current (latest) period so next is disabled', () => {
    expect(isFuturePeriod('day', '2026-07-05', NOW)).toBe(true);
    expect(isFuturePeriod('day', '2026-07-04', NOW)).toBe(false);
    expect(isFuturePeriod('month', '2026-08-01', NOW)).toBe(true);
  });
});

describe('combat column visibility', () => {
  it('hides combat columns when combat data is unavailable', () => {
    const keys = visibleColumns(false).map((column) => column.key);
    expect(keys).toEqual(['rank', 'player', 'online', 'seeding']);
    expect(keys).not.toContain('kills');
  });

  it('shows every column once combat data is available', () => {
    const keys = visibleColumns(true).map((column) => column.key);
    expect(keys).toEqual([
      'rank',
      'player',
      'online',
      'kills',
      'deaths',
      'kd',
      'revives',
      'seeding',
    ]);
  });
});

describe('economy column visibility (LEAD-4)', () => {
  it('hides bonus and boost columns when economy is disabled', () => {
    const keys = visibleColumns(true, false).map((column) => column.key);
    expect(keys).not.toContain('bonus');
    expect(keys).not.toContain('boost');
  });

  it('shows bonus and boost columns when economy is enabled', () => {
    const keys = visibleColumns(true, true).map((column) => column.key);
    expect(keys).toContain('bonus');
    expect(keys).toContain('boost');
  });

  it('defaults to hiding economy columns when the flag is omitted', () => {
    const keys = visibleColumns(false).map((column) => column.key);
    expect(keys).toEqual(['rank', 'player', 'online', 'seeding']);
  });

  it('formats boost as a duration and bonus as a count', () => {
    expect(normalizeSpaces(formatMetricValue('boost', 3600))).toBe('1ч 0м');
    expect(normalizeSpaces(formatMetricValue('bonus', 12345))).toBe('12 345');
  });

  it('names the seeding component in the bonus tooltip (LEAD-6)', () => {
    const bonus = COLUMNS.find((column) => column.key === 'bonus');
    expect(bonus?.tooltip).toContain('сидинг');
    expect(bonus?.tooltip).toBe(
      'Начисленные бонусы (онлайн + буст + сидинг по коэффициентам экономики)',
    );
  });
});

describe('medal rendering', () => {
  it('awards medals to the top three ranks only', () => {
    expect(medalFor(1)).toBe('🥇');
    expect(medalFor(2)).toBe('🥈');
    expect(medalFor(3)).toBe('🥉');
    expect(medalFor(4)).toBeNull();
    expect(medalFor(0)).toBeNull();
  });
});

describe('row click guard', () => {
  it('navigates on a plain left click', () => {
    expect(shouldNavigateRow({})).toBe(true);
  });

  it('does not hijack modified clicks or active text selection', () => {
    expect(shouldNavigateRow({ ctrlKey: true })).toBe(false);
    expect(shouldNavigateRow({ metaKey: true })).toBe(false);
    expect(shouldNavigateRow({ altKey: true })).toBe(false);
    expect(shouldNavigateRow({ shiftKey: true })).toBe(false);
    expect(shouldNavigateRow({ hasSelection: true })).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations in hours and minutes', () => {
    expect(formatDuration(0)).toBe('0м');
    expect(formatDuration(600)).toBe('10м');
    expect(formatDuration(3660)).toBe('1ч 1м');
  });

  it('formats metric values per metric type', () => {
    expect(formatMetricValue('online', 3660)).toBe('1ч 1м');
    expect(formatMetricValue('kd', 1.5)).toBe('1.50');
    expect(normalizeSpaces(formatMetricValue('kills', 1234))).toBe('1 234');
  });

  it('builds the pagination info row with grouped thousands', () => {
    expect(normalizeSpaces(pageInfoLabel(2, 5, 1234))).toBe('Страница 2 из 5 · Всего 1 234');
  });

  it('labels navigable period ranges', () => {
    expect(periodRangeLabel('alltime', '')).toBe('Всё время');
  });

  it('labels a season by its name, not by a calendar year', () => {
    expect(periodRangeLabel('season', '2026-06-01', makeSeason({ name: 'Лето 2026' }))).toBe(
      'Лето 2026',
    );
    // No season loaded yet (or an unknown period_start): fall back to the
    // generic chip label rather than inventing a year.
    expect(periodRangeLabel('season', '2026-06-01')).toBe('Сезон');
    expect(periodRangeLabel('season', '')).toBe('Сезон');
  });
});

describe('season selector (LEAD-7)', () => {
  it('derives period_start from starts_at in UTC', () => {
    expect(seasonPeriodStart(makeSeason({ starts_at: '2026-06-01T00:00:00.000Z' }))).toBe(
      '2026-06-01',
    );
    // 23:30Z is still the same UTC day even though it is the next day locally.
    expect(seasonPeriodStart(makeSeason({ starts_at: '2026-06-01T23:30:00.000Z' }))).toBe(
      '2026-06-01',
    );
  });

  it('treats closed and finalized seasons as read-only', () => {
    expect(isSeasonReadOnly(makeSeason({ status: 'active', finalized: false }))).toBe(false);
    expect(isSeasonReadOnly(makeSeason({ status: 'upcoming', finalized: false }))).toBe(false);
    expect(isSeasonReadOnly(makeSeason({ status: 'closed', finalized: false }))).toBe(true);
    expect(isSeasonReadOnly(makeSeason({ status: 'active', finalized: true }))).toBe(true);
  });

  it('marks a read-only season in its option label', () => {
    expect(seasonOptionLabel(makeSeason({ name: 'Лето 2026' }))).toBe('Лето 2026');
    expect(seasonOptionLabel(makeSeason({ name: 'Зима 2025', status: 'closed' }))).toBe(
      'Зима 2025 (архив)',
    );
  });

  it('formats the season date range', () => {
    expect(normalizeSpaces(seasonRangeLabel(makeSeason()))).toBe('01.06.2026 — 31.08.2026');
  });

  it('finds the season matching a period_start', () => {
    const seasons = [
      makeSeason({ id: 'a' }),
      makeSeason({ id: 'b', starts_at: '2026-01-05T00:00:00.000Z' }),
    ];
    expect(findSeason(seasons, '2026-01-05')?.id).toBe('b');
    expect(findSeason(seasons, '2026-06-01')?.id).toBe('a');
    expect(findSeason(seasons, '1999-01-01')).toBeNull();
    expect(findSeason([], '2026-06-01')).toBeNull();
  });

  it('defaults to the active season, then to the most recent one', () => {
    const closed = makeSeason({
      id: 'old',
      status: 'closed',
      starts_at: '2025-01-01T00:00:00.000Z',
    });
    const active = makeSeason({
      id: 'live',
      status: 'active',
      starts_at: '2026-06-01T00:00:00.000Z',
    });
    expect(defaultSeasonPeriodStart([closed, active])).toBe('2026-06-01');
    expect(defaultSeasonPeriodStart([closed])).toBe('2025-01-01');
    expect(defaultSeasonPeriodStart([])).toBe('');
  });

  it('orders the selector newest first', () => {
    const older = makeSeason({ id: 'older', starts_at: '2025-01-01T00:00:00.000Z' });
    const newer = makeSeason({ id: 'newer', starts_at: '2026-06-01T00:00:00.000Z' });
    expect(sortSeasonsForSelector([older, newer]).map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('sends period_start for seasons even though they are not arrow-navigable', () => {
    expect(periodHasStart('season')).toBe(true);
    expect(canNavigatePeriod('season')).toBe(false);
    expect(periodHasStart('alltime')).toBe(false);

    const query = buildApiQuery(withFilters({ period: 'season', periodStart: '2026-06-01' }));
    expect(query).toContain('period_start=2026-06-01');
    const url = buildQueryString(withFilters({ period: 'season', periodStart: '2026-06-01' }));
    expect(url).toContain('start=2026-06-01');
  });

  it('omits period_start for a season that has not been resolved yet', () => {
    expect(buildApiQuery(withFilters({ period: 'season', periodStart: '' }))).not.toContain(
      'period_start',
    );
  });
});
