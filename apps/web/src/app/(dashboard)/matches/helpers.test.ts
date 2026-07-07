import { describe, expect, it } from 'vitest';
import {
  appendMatchPage,
  buildCountApiQuery,
  buildExportUrl,
  buildListApiQuery,
  buildMatchDetailHref,
  buildQueryString,
  defaultFilters,
  formatDateTime,
  formatDuration,
  formatKillDeathStat,
  formatMatchStat,
  isOpenMatch,
  type MatchFilters,
  type MatchListItem,
  mergeMatchPage,
  nextSort,
  parseFilters,
  resolveDateRange,
  safeMatchBackHref,
  serverOptionsFromMatches,
  shortServerName,
  teamPillTone,
  winnerLabel,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function makeMatch(overrides: Partial<MatchListItem> = {}): MatchListItem {
  return {
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    server_id: overrides.server_id ?? 'srv-1',
    server_name: overrides.server_name ?? 'Main Server',
    server_slug: overrides.server_slug ?? 'main',
    layer: overrides.layer ?? 'Yehorivka_RAAS_v1',
    map: overrides.map ?? 'Yehorivka',
    game_mode: overrides.game_mode ?? 'RAAS',
    team1_faction: overrides.team1_faction ?? 'USA',
    team2_faction: overrides.team2_faction ?? 'RUS',
    team1_tickets: overrides.team1_tickets ?? 250,
    team2_tickets: overrides.team2_tickets ?? 0,
    winner: overrides.winner ?? 'team1',
    is_seed: overrides.is_seed ?? false,
    started_at: overrides.started_at ?? '2026-07-04T10:00:00.000Z',
    ended_at: overrides.ended_at === undefined ? '2026-07-04T11:00:00.000Z' : overrides.ended_at,
    duration_seconds: overrides.duration_seconds === undefined ? 3600 : overrides.duration_seconds,
    end_reason: overrides.end_reason ?? 'ended',
  };
}

describe('parseFilters', () => {
  it('applies defaults for empty params', () => {
    const filters = parseFilters(params(''));
    expect(filters).toEqual(defaultFilters());
  });

  it('hides seeding by default and shows it only with seeding=show', () => {
    expect(parseFilters(params('')).hideSeeding).toBe(true);
    expect(parseFilters(params('seeding=show')).hideSeeding).toBe(false);
  });

  it('parses layer, servers list, preset, sort, order and player', () => {
    const filters = parseFilters(
      params('layer=Yeho&servers=a,b,c&preset=week&sort=duration_seconds&order=asc&player=p1'),
    );
    expect(filters.layer).toBe('Yeho');
    expect(filters.servers).toEqual(['a', 'b', 'c']);
    expect(filters.preset).toBe('week');
    expect(filters.sort).toBe('duration_seconds');
    expect(filters.order).toBe('asc');
    expect(filters.playerId).toBe('p1');
  });

  it('rejects unknown preset and sort values', () => {
    const filters = parseFilters(params('preset=decade&sort=kills'));
    expect(filters.preset).toBe('all');
    expect(filters.sort).toBe('started_at');
  });
});

describe('buildQueryString round-trips filters', () => {
  it('omits defaults from the URL', () => {
    expect(buildQueryString(defaultFilters())).toBe('');
  });

  it('serialises only non-default filters and re-parses to the same shape', () => {
    const filters: MatchFilters = {
      layer: 'Narva',
      servers: ['s1', 's2'],
      preset: 'custom',
      from: '2026-07-01',
      to: '2026-07-03',
      hideSeeding: false,
      sort: 'layer',
      order: 'asc',
      playerId: 'player-9',
    };
    const round = parseFilters(params(buildQueryString(filters)));
    expect(round).toEqual(filters);
  });

  it('drops custom dates when preset is not custom', () => {
    const filters: MatchFilters = {
      ...defaultFilters(),
      preset: 'week',
      from: '2026-07-01',
      to: '2026-07-03',
    };
    const query = buildQueryString(filters);
    expect(query).not.toContain('from=');
    expect(query).not.toContain('to=');
  });
});

describe('resolveDateRange', () => {
  const now = new Date(2026, 6, 4, 15, 30, 0);

  it('returns no bounds for all', () => {
    expect(resolveDateRange({ ...defaultFilters(), preset: 'all' }, now)).toEqual({});
  });

  it('today starts at local midnight and ends at now', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: 'today' }, now);
    expect(range.dateFrom?.getHours()).toBe(0);
    expect(range.dateFrom?.getDate()).toBe(4);
    expect(range.dateTo).toEqual(now);
  });

  it('yesterday is the full previous day', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: 'yesterday' }, now);
    expect(range.dateFrom?.getDate()).toBe(3);
    expect(range.dateFrom?.getHours()).toBe(0);
    expect(range.dateTo?.getDate()).toBe(3);
    expect(range.dateTo?.getHours()).toBe(23);
  });

  it('week spans the last seven local days', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: 'week' }, now);
    expect(range.dateFrom?.getDate()).toBe(28);
    expect(range.dateFrom?.getMonth()).toBe(5);
  });

  it('month starts at the first of the current month', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: 'month' }, now);
    expect(range.dateFrom?.getDate()).toBe(1);
    expect(range.dateFrom?.getMonth()).toBe(6);
  });

  it('30days is a rolling thirty-day window', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: '30days' }, now);
    expect(range.dateTo).toEqual(now);
    expect((now.getTime() - (range.dateFrom?.getTime() ?? 0)) / (24 * 60 * 60 * 1000)).toBe(30);
  });

  it('custom parses from/to YYYY-MM-DD to day boundaries', () => {
    const range = resolveDateRange(
      { ...defaultFilters(), preset: 'custom', from: '2026-07-01', to: '2026-07-02' },
      now,
    );
    expect(range.dateFrom?.getDate()).toBe(1);
    expect(range.dateFrom?.getHours()).toBe(0);
    expect(range.dateTo?.getDate()).toBe(2);
    expect(range.dateTo?.getHours()).toBe(23);
  });

  it('custom ignores malformed dates', () => {
    const range = resolveDateRange(
      { ...defaultFilters(), preset: 'custom', from: 'nope', to: '' },
      now,
    );
    expect(range).toEqual({});
  });
});

describe('buildListApiQuery', () => {
  const now = new Date(2026, 6, 4, 15, 30, 0);

  it('always sends hideSeeding, sort, order and limit', () => {
    const query = params(buildListApiQuery(defaultFilters(), { now, limit: 50 }));
    expect(query.get('hideSeeding')).toBe('true');
    expect(query.get('sort')).toBe('started_at');
    expect(query.get('order')).toBe('desc');
    expect(query.get('limit')).toBe('50');
    expect(query.has('cursor')).toBe(false);
  });

  it('repeats serverIds and passes cursor and date bounds', () => {
    const filters: MatchFilters = {
      ...defaultFilters(),
      servers: ['a', 'b'],
      preset: 'today',
      hideSeeding: false,
    };
    const query = params(buildListApiQuery(filters, { now, cursor: 'abc' }));
    expect(query.getAll('serverIds')).toEqual(['a', 'b']);
    expect(query.get('hideSeeding')).toBe('false');
    expect(query.get('cursor')).toBe('abc');
    expect(query.get('dateFrom')).toBeTruthy();
  });
});

describe('buildCountApiQuery and buildExportUrl', () => {
  it('count omits pagination keys', () => {
    const query = params(buildCountApiQuery(defaultFilters()));
    expect(query.has('sort')).toBe(false);
    expect(query.has('cursor')).toBe(false);
    expect(query.has('limit')).toBe(false);
    expect(query.get('hideSeeding')).toBe('true');
  });

  it('export targets the csv endpoint with filters', () => {
    const url = buildExportUrl({ ...defaultFilters(), layer: 'Narva' });
    expect(url.startsWith('/api/v1/matches/export?')).toBe(true);
    expect(url).toContain('format=csv');
    expect(url).toContain('layer=Narva');
  });
});

describe('match detail links', () => {
  it('preserves safe match list filters when opening a card', () => {
    expect(buildMatchDetailHref('match-1', '/matches?player=p1&preset=week')).toBe(
      '/matches/match-1?from=%2Fmatches%3Fplayer%3Dp1%26preset%3Dweek',
    );
  });

  it('omits a redundant return parameter for the plain list', () => {
    expect(buildMatchDetailHref('match-1', '/matches')).toBe('/matches/match-1');
  });

  it('rejects unsafe return targets', () => {
    expect(safeMatchBackHref('https://example.com/matches')).toBe('/matches');
    expect(safeMatchBackHref('//example.com/matches')).toBe('/matches');
    expect(safeMatchBackHref('/players/p1')).toBe('/matches');
    expect(safeMatchBackHref(['/matches?player=p1', '/players/p1'])).toBe('/matches?player=p1');
  });
});

describe('nextSort', () => {
  it('toggles order when the same column is clicked', () => {
    expect(
      nextSort({ ...defaultFilters(), sort: 'started_at', order: 'desc' }, 'started_at'),
    ).toEqual({
      sort: 'started_at',
      order: 'asc',
    });
  });

  it('defaults to desc for time and duration, asc for layer', () => {
    expect(nextSort(defaultFilters(), 'duration_seconds')).toEqual({
      sort: 'duration_seconds',
      order: 'desc',
    });
    expect(nextSort(defaultFilters(), 'layer')).toEqual({ sort: 'layer', order: 'asc' });
  });
});

describe('teamPillTone', () => {
  it('marks winner green and loser red', () => {
    expect(teamPillTone(1, 'team1')).toBe('winner');
    expect(teamPillTone(2, 'team1')).toBe('loser');
    expect(teamPillTone(2, 'team2')).toBe('winner');
  });

  it('is neutral for draw and unfinished matches', () => {
    expect(teamPillTone(1, 'draw')).toBe('neutral');
    expect(teamPillTone(1, null)).toBe('neutral');
  });
});

describe('formatDuration', () => {
  it('handles null, seconds, minutes and hours', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(42)).toBe('42с');
    expect(formatDuration(150)).toBe('2м 30с');
    expect(formatDuration(3720)).toBe('1ч 2м');
  });
});

describe('combat stat formatting', () => {
  it('keeps absent combat data visibly absent', () => {
    expect(formatMatchStat(null)).toBe('—');
    expect(formatKillDeathStat(null, null)).toBe('—');
  });

  it('formats real zeroes and kill/death pairs', () => {
    expect(formatMatchStat(0)).toBe('0');
    expect(formatMatchStat(12)).toBe('12');
    expect(formatKillDeathStat(8, 2)).toBe('8/2');
    expect(formatKillDeathStat(0, 0)).toBe('0/0');
  });
});

describe('open match helpers', () => {
  it('detects open matches by null ended_at', () => {
    expect(isOpenMatch(makeMatch({ ended_at: null }))).toBe(true);
    expect(isOpenMatch(makeMatch())).toBe(false);
  });

  it('winnerLabel is a dash for open matches', () => {
    expect(winnerLabel(makeMatch({ ended_at: null, winner: null }))).toBe('—');
    expect(winnerLabel(makeMatch({ winner: 'team2' }))).toBe('Команда 2');
    expect(winnerLabel(makeMatch({ winner: 'draw' }))).toBe('Ничья');
  });

  it('formatDateTime returns a dash for null and invalid input', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime('2026-07-04T10:00:00.000Z')).not.toBe('—');
  });
});

describe('shortServerName and serverOptionsFromMatches', () => {
  it('prefers slug then name', () => {
    expect(shortServerName({ server_slug: 'eu1', server_name: 'EU One' })).toBe('eu1');
    expect(shortServerName({ server_slug: null, server_name: 'EU One' })).toBe('EU One');
    expect(shortServerName({ server_slug: null, server_name: null })).toBe('—');
  });

  it('derives a de-duplicated server option list', () => {
    const options = serverOptionsFromMatches([
      makeMatch({ id: 'm1', server_id: 's1', server_slug: 's1' }),
      makeMatch({ id: 'm2', server_id: 's1', server_slug: 's1' }),
      makeMatch({ id: 'm3', server_id: 's2', server_slug: 's2' }),
    ]);
    expect(options.map((option) => option.id)).toEqual(['s1', 's2']);
  });
});

describe('mergeMatchPage and appendMatchPage', () => {
  it('merge keeps the fresh head and dedupes the tail', () => {
    const fresh = [makeMatch({ id: 'a' }), makeMatch({ id: 'b' })];
    const existing = [makeMatch({ id: 'b' }), makeMatch({ id: 'c' })];
    const merged = mergeMatchPage(fresh, existing);
    expect(merged.map((match) => match.id)).toEqual(['a', 'b', 'c']);
  });

  it('append ignores ids already loaded', () => {
    const existing = [makeMatch({ id: 'a' }), makeMatch({ id: 'b' })];
    const incoming = [makeMatch({ id: 'b' }), makeMatch({ id: 'c' })];
    const result = appendMatchPage(existing, incoming);
    expect(result.map((match) => match.id)).toEqual(['a', 'b', 'c']);
  });
});
