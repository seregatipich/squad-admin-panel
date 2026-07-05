import { describe, expect, it } from 'vitest';
import {
  appendVotePage,
  buildCountApiQuery,
  buildListApiQuery,
  buildQueryString,
  defaultFilters,
  formatDuration,
  mapChain,
  mergeVotePage,
  parseFilters,
  resolveDateRange,
  resultLabel,
  resultTone,
  serverOptionsFromVotes,
  shortServerName,
  type VoteFilters,
  type VoteListItem,
  voteTypeLabel,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function makeVote(overrides: Partial<VoteListItem> = {}): VoteListItem {
  return {
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    server_id: overrides.server_id ?? 'srv-1',
    server_name: overrides.server_name ?? 'Main Server',
    server_slug: overrides.server_slug ?? 'main',
    initiator_player_id: overrides.initiator_player_id ?? 'plr-1',
    initiator_nickname: overrides.initiator_nickname ?? 'Initiator',
    vote_type: overrides.vote_type ?? 'map_skip',
    map_current: overrides.map_current === undefined ? 'Yehorivka_RAAS_v1' : overrides.map_current,
    map_next: overrides.map_next === undefined ? 'Narva_RAAS_v1' : overrides.map_next,
    map_target: overrides.map_target === undefined ? null : overrides.map_target,
    votes_collected: overrides.votes_collected ?? 12,
    votes_required: overrides.votes_required ?? 20,
    result: overrides.result === undefined ? 'passed' : overrides.result,
    duration_seconds: overrides.duration_seconds === undefined ? 45 : overrides.duration_seconds,
    started_at: overrides.started_at ?? '2026-07-04T10:00:00.000Z',
    ended_at: overrides.ended_at === undefined ? '2026-07-04T10:00:45.000Z' : overrides.ended_at,
    ballot_count: overrides.ballot_count ?? 12,
  };
}

describe('parseFilters', () => {
  it('returns defaults for empty params', () => {
    expect(parseFilters(params(''))).toEqual(defaultFilters());
  });

  it('parses all filters from the query string', () => {
    const parsed = parseFilters(
      params('servers=a,b&type=map_change&result=failed&q=Rambo&preset=week&order=asc'),
    );
    expect(parsed.servers).toEqual(['a', 'b']);
    expect(parsed.voteType).toBe('map_change');
    expect(parsed.result).toBe('failed');
    expect(parsed.initiatorQuery).toBe('Rambo');
    expect(parsed.preset).toBe('week');
    expect(parsed.order).toBe('asc');
  });

  it('rejects invalid enum values', () => {
    const parsed = parseFilters(params('type=bogus&result=nope&preset=weird&order=sideways'));
    expect(parsed.voteType).toBe('');
    expect(parsed.result).toBe('');
    expect(parsed.preset).toBe('all');
    expect(parsed.order).toBe('desc');
  });
});

describe('buildQueryString round-trip', () => {
  it('preserves filters through parse', () => {
    const filters: VoteFilters = {
      servers: ['s1', 's2'],
      voteType: 'admin',
      result: 'cancelled',
      initiatorQuery: 'Ghost',
      preset: 'custom',
      from: '2026-07-01',
      to: '2026-07-04',
      order: 'asc',
    };
    const round = parseFilters(params(buildQueryString(filters)));
    expect(round).toEqual(filters);
  });

  it('omits defaults', () => {
    expect(buildQueryString(defaultFilters())).toBe('');
  });
});

describe('buildListApiQuery', () => {
  it('serializes multi-server, type, result, initiator and order', () => {
    const filters: VoteFilters = {
      ...defaultFilters(),
      servers: ['s1', 's2'],
      voteType: 'map_skip',
      result: 'passed',
      initiatorQuery: 'Neo',
      order: 'asc',
    };
    const qs = buildListApiQuery(filters, { limit: 25 });
    const parsed = new URLSearchParams(qs);
    expect(parsed.getAll('serverId')).toEqual(['s1', 's2']);
    expect(parsed.get('voteType')).toBe('map_skip');
    expect(parsed.get('result')).toBe('passed');
    expect(parsed.get('initiatorQuery')).toBe('Neo');
    expect(parsed.get('order')).toBe('asc');
    expect(parsed.get('limit')).toBe('25');
  });

  it('includes the cursor when provided', () => {
    const qs = buildListApiQuery(defaultFilters(), { cursor: 'abc' });
    expect(new URLSearchParams(qs).get('cursor')).toBe('abc');
  });

  it('resolves a date range into ISO bounds', () => {
    const now = new Date('2026-07-04T12:00:00.000Z');
    const qs = buildCountApiQuery({ ...defaultFilters(), preset: '30days' }, now);
    const parsed = new URLSearchParams(qs);
    expect(parsed.get('dateFrom')).toBeTruthy();
    expect(parsed.get('dateTo')).toBeTruthy();
  });
});

describe('resolveDateRange', () => {
  it('returns an empty range for the "all" preset', () => {
    expect(resolveDateRange({ ...defaultFilters(), preset: 'all' })).toEqual({});
  });

  it('bounds the custom preset by parsed dates', () => {
    const range = resolveDateRange({
      ...defaultFilters(),
      preset: 'custom',
      from: '2026-07-01',
      to: '2026-07-02',
    });
    expect(range.dateFrom?.getFullYear()).toBe(2026);
    expect(range.dateTo?.getHours()).toBe(23);
  });
});

describe('label + tone helpers', () => {
  it('maps vote types to Russian labels', () => {
    expect(voteTypeLabel('map_skip')).toBe('Скип карты');
    expect(voteTypeLabel('map_change')).toBe('Смена карты');
    expect(voteTypeLabel('admin')).toBe('Админ');
    expect(voteTypeLabel('unknown')).toBe('unknown');
  });

  it('derives result tone and label', () => {
    expect(resultTone('passed')).toBe('passed');
    expect(resultTone('failed')).toBe('failed');
    expect(resultTone('cancelled')).toBe('cancelled');
    expect(resultTone(null)).toBe('pending');
    expect(resultLabel('passed')).toBe('Принято');
    expect(resultLabel(null)).toBe('В процессе');
  });
});

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(45)).toBe('45с');
    expect(formatDuration(125)).toBe('2м 5с');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('mapChain', () => {
  it('drops empty map slots', () => {
    expect(mapChain({ map_current: 'A', map_next: 'B', map_target: null })).toEqual(['A', 'B']);
    expect(mapChain({ map_current: null, map_next: null, map_target: 'C' })).toEqual(['C']);
  });
});

describe('shortServerName', () => {
  it('prefers slug then name', () => {
    expect(shortServerName({ server_slug: 'eu-1', server_name: 'EU One' })).toBe('eu-1');
    expect(shortServerName({ server_slug: null, server_name: 'EU One' })).toBe('EU One');
    expect(shortServerName({ server_slug: null, server_name: null })).toBe('—');
  });
});

describe('serverOptionsFromVotes', () => {
  it('deduplicates servers from a vote list', () => {
    const options = serverOptionsFromVotes([
      makeVote({ id: 'v1', server_id: 's1' }),
      makeVote({ id: 'v2', server_id: 's1' }),
      makeVote({ id: 'v3', server_id: 's2' }),
    ]);
    expect(options.map((entry) => entry.id)).toEqual(['s1', 's2']);
  });
});

describe('mergeVotePage / appendVotePage', () => {
  it('prepends fresh votes and de-dupes the tail', () => {
    const existing = [makeVote({ id: 'v1' }), makeVote({ id: 'v2' })];
    const fresh = [makeVote({ id: 'v3' }), makeVote({ id: 'v1' })];
    expect(mergeVotePage(fresh, existing).map((vote) => vote.id)).toEqual(['v3', 'v1', 'v2']);
  });

  it('appends only new votes on pagination', () => {
    const existing = [makeVote({ id: 'v1' })];
    const incoming = [makeVote({ id: 'v1' }), makeVote({ id: 'v2' })];
    expect(appendVotePage(existing, incoming).map((vote) => vote.id)).toEqual(['v1', 'v2']);
  });
});
