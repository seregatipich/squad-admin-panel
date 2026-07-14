import { describe, expect, it } from 'vitest';
import {
  buildApiQuery,
  buildQueryString,
  DEFAULT_LIMIT,
  identityLabel,
  parseFilters,
} from './helpers';

function params(record: Record<string, string>): { get(key: string): string | null } {
  return { get: (key: string) => record[key] ?? null };
}

describe('parseFilters', () => {
  it('defaults to empty q/sourceId, permanentOnly=false, limit=25, offset=0', () => {
    expect(parseFilters(params({}))).toEqual({
      q: '',
      permanentOnly: false,
      sourceId: '',
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it('reads q, permanent_only, source_id, limit, offset from params', () => {
    expect(
      parseFilters(
        params({
          q: 'Cheater',
          permanent_only: 'true',
          source_id: 'src-1',
          limit: '10',
          offset: '20',
        }),
      ),
    ).toEqual({ q: 'Cheater', permanentOnly: true, sourceId: 'src-1', limit: 10, offset: 20 });
  });

  it('falls back to defaults for invalid limit/offset', () => {
    expect(parseFilters(params({ limit: 'abc', offset: '-5' }))).toEqual({
      q: '',
      permanentOnly: false,
      sourceId: '',
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
  });
});

describe('buildQueryString', () => {
  it('omits every field at its default value', () => {
    expect(
      buildQueryString({
        q: '',
        permanentOnly: false,
        sourceId: '',
        limit: DEFAULT_LIMIT,
        offset: 0,
      }),
    ).toBe('');
  });

  it('encodes q/permanent_only/source_id/limit/offset when non-default', () => {
    const qs = buildQueryString({
      q: 'Cheater',
      permanentOnly: true,
      sourceId: 'src-1',
      limit: 10,
      offset: 20,
    });
    const parsed = new URLSearchParams(qs);
    expect(parsed.get('q')).toBe('Cheater');
    expect(parsed.get('permanent_only')).toBe('true');
    expect(parsed.get('source_id')).toBe('src-1');
    expect(parsed.get('limit')).toBe('10');
    expect(parsed.get('offset')).toBe('20');
  });
});

describe('buildApiQuery', () => {
  it('always includes limit and offset even at defaults', () => {
    const qs = buildApiQuery({ q: '', permanentOnly: false, sourceId: '', limit: 25, offset: 0 });
    const parsed = new URLSearchParams(qs);
    expect(parsed.get('limit')).toBe('25');
    expect(parsed.get('offset')).toBe('0');
    expect(parsed.has('q')).toBe(false);
    expect(parsed.has('permanent_only')).toBe(false);
    expect(parsed.has('source_id')).toBe(false);
  });

  it('encodes non-empty q/permanent_only/source_id', () => {
    const qs = buildApiQuery({
      q: 'SteamID64',
      permanentOnly: true,
      sourceId: 'src-2',
      limit: 25,
      offset: 0,
    });
    const parsed = new URLSearchParams(qs);
    expect(parsed.get('q')).toBe('SteamID64');
    expect(parsed.get('permanent_only')).toBe('true');
    expect(parsed.get('source_id')).toBe('src-2');
  });
});

describe('identityLabel', () => {
  it('prefers the panel nickname when known', () => {
    expect(
      identityLabel({
        player_id: 'p1',
        panel_nickname: 'PanelNick',
        bans: [{ nickname: 'ExtNick' }],
      }),
    ).toBe('PanelNick');
  });

  it('falls back to the latest external nickname when unknown to the panel', () => {
    expect(
      identityLabel({ player_id: null, panel_nickname: null, bans: [{ nickname: 'ExtNick' }] }),
    ).toBe('ExtNick');
  });

  it('falls back to "нет ника" when no nickname is available anywhere', () => {
    expect(
      identityLabel({ player_id: null, panel_nickname: null, bans: [{ nickname: null }] }),
    ).toBe('нет ника');
  });
});
