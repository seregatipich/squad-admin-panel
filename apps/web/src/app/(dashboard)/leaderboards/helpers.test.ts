import { describe, expect, it } from 'vitest';
import {
  buildApiQuery,
  buildQueryString,
  COLUMNS,
  canNavigatePeriod,
  columnMetric,
  currentPeriodStart,
  defaultFilters,
  formatDuration,
  formatMetricValue,
  isFuturePeriod,
  isoWeekStart,
  type LeaderboardFilters,
  medalFor,
  nextSort,
  pageInfoLabel,
  parseFilters,
  periodRangeLabel,
  shiftPeriodStart,
  shouldNavigateRow,
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
    expect(currentPeriodStart('season', NOW)).toBe('2026-01-01');
    expect(currentPeriodStart('alltime', NOW)).toBe('');
  });

  it('steps day/week/month/season backward and forward', () => {
    expect(shiftPeriodStart('day', '2026-07-05', -1)).toBe('2026-07-04');
    expect(shiftPeriodStart('day', '2026-07-05', 1)).toBe('2026-07-06');
    expect(shiftPeriodStart('week', '2026-06-29', -1)).toBe('2026-06-22');
    expect(shiftPeriodStart('month', '2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftPeriodStart('season', '2026-01-01', 1)).toBe('2027-01-01');
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
    expect(periodRangeLabel('season', '2026-01-01')).toBe('Сезон 2026');
  });
});
