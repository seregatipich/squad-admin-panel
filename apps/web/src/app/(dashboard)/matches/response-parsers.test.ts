import { describe, expect, it } from 'vitest';
import {
  MALFORMED_RESPONSE_MESSAGE,
  parseMatchCount,
  parseMatchDetail,
  parseMatchListResponse,
  parseServerOptions,
} from './response-parsers';

const listItem = {
  id: 'm1',
  server_id: 's1',
  started_at: '2026-01-01T00:00:00Z',
  ended_at: null,
};
const team = { players: 10, play_seconds: 100 };
const detail = {
  ...listItem,
  roster: [{ player_id: 'p1', nickname: 'Nick', play_seconds: 5 }],
  teams: { team1: team, team2: team },
  combat_events: null,
};

describe('parseMatchListResponse', () => {
  it('accepts a page', () => {
    const body = { items: [listItem], next_cursor: null, limit: 50 };
    expect(parseMatchListResponse(body)).toBe(body);
  });

  it.each([
    ['an error body', { error: 'boom' }],
    ['items that are not an array', { items: {}, next_cursor: null }],
    ['an item without id', { items: [{ started_at: 'x' }], next_cursor: null }],
    ['a non-string cursor', { items: [], next_cursor: 5 }],
    ['null', null],
  ])('rejects %s', (_label, body) => {
    expect(() => parseMatchListResponse(body)).toThrow(MALFORMED_RESPONSE_MESSAGE);
  });
});

describe('parseMatchDetail', () => {
  it('accepts a match with and without combat events', () => {
    expect(parseMatchDetail(detail)).toBe(detail);
    expect(parseMatchDetail({ ...detail, combat_events: [] })).toBeTruthy();
  });

  it.each([
    ['a missing roster', { ...detail, roster: undefined }],
    ['a missing team aggregate', { ...detail, teams: { team1: team } }],
    ['malformed combat events', { ...detail, combat_events: [{}] }],
    ['an error body', { error: 'x' }],
  ])('rejects %s instead of crashing the render', (_label, body) => {
    expect(() => parseMatchDetail(body)).toThrow(MALFORMED_RESPONSE_MESSAGE);
  });
});

describe('parseMatchCount', () => {
  it('returns the total, including zero', () => {
    expect(parseMatchCount({ total: 0 })).toBe(0);
  });

  it('rejects a body without a numeric total', () => {
    expect(() => parseMatchCount({ total: '3' })).toThrow(MALFORMED_RESPONSE_MESSAGE);
  });
});

describe('parseServerOptions', () => {
  it('keeps only the fields the filter shows and nulls missing names', () => {
    expect(parseServerOptions({ items: [{ id: 's1', display_name: 'A', extra: 1 }] })).toEqual([
      { id: 's1', display_name: 'A', slug: null },
    ]);
  });

  it('rejects entries without an id', () => {
    expect(() => parseServerOptions({ items: [{}] })).toThrow(MALFORMED_RESPONSE_MESSAGE);
  });
});
