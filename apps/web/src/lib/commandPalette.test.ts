import { describe, expect, it } from 'vitest';
import {
  filterPageResults,
  filterServerResults,
  isPaletteHotkey,
  type PaletteResult,
  PLAYER_SEARCH_MIN_LENGTH,
  resultHref,
  resultLabel,
  shouldSearchPlayers,
} from './commandPalette';
import type { NavGroup } from './nav';

const GROUPS: NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'Дашборд' }] },
  {
    label: 'Управление',
    items: [
      { href: '/players', label: 'Игроки' },
      { href: '/users', label: 'Пользователи', permission: 'user:view' },
    ],
  },
];

describe('filterPageResults', () => {
  it('returns every visible page when the query is empty', () => {
    const result = filterPageResults(GROUPS, [], '');
    expect(result.map((r) => r.href)).toEqual(['/dashboard', '/players']);
  });

  it('hides permission-gated pages when the permission is absent', () => {
    const result = filterPageResults(GROUPS, [], '');
    expect(result.find((r) => r.href === '/users')).toBeUndefined();
  });

  it('includes permission-gated pages when the permission is present', () => {
    const result = filterPageResults(GROUPS, ['user:view'], '');
    expect(result.find((r) => r.href === '/users')).toBeDefined();
  });

  it('filters by case-insensitive label match', () => {
    const result = filterPageResults(GROUPS, [], 'игр');
    expect(result.map((r) => r.href)).toEqual(['/players']);
  });

  it('filters by href match', () => {
    const result = filterPageResults(GROUPS, [], 'dashboard');
    expect(result.map((r) => r.href)).toEqual(['/dashboard']);
  });

  it('returns nothing when the query matches no page', () => {
    expect(filterPageResults(GROUPS, [], 'zzz-nope')).toEqual([]);
  });
});

describe('filterServerResults', () => {
  const servers = [
    { id: 's1', display_name: 'Squad EU #1', slug: 'eu-1' },
    { id: 's2', display_name: 'Squad US #1', slug: 'us-1' },
  ];

  it('returns every server when the query is empty', () => {
    expect(filterServerResults(servers, '')).toEqual(servers);
  });

  it('filters by display name, case-insensitively', () => {
    expect(filterServerResults(servers, 'eu')).toEqual([servers[0]]);
  });

  it('filters by slug', () => {
    expect(filterServerResults(servers, 'us-1')).toEqual([servers[1]]);
  });
});

describe('shouldSearchPlayers', () => {
  it(`is false below ${PLAYER_SEARCH_MIN_LENGTH} characters`, () => {
    expect(shouldSearchPlayers('ab')).toBe(false);
  });

  it(`is true at exactly ${PLAYER_SEARCH_MIN_LENGTH} characters`, () => {
    expect(shouldSearchPlayers('abc')).toBe(true);
  });

  it('trims whitespace before measuring length', () => {
    expect(shouldSearchPlayers('  ab  ')).toBe(false);
    expect(shouldSearchPlayers('  abc  ')).toBe(true);
  });
});

describe('isPaletteHotkey', () => {
  it('matches Ctrl+K', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true, metaKey: false })).toBe(true);
  });

  it('matches Cmd+K (metaKey)', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('is case-insensitive on the key', () => {
    expect(isPaletteHotkey({ key: 'K', ctrlKey: true, metaKey: false })).toBe(true);
  });

  it('does not match K without a modifier', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('does not match Ctrl with a different key', () => {
    expect(isPaletteHotkey({ key: 'p', ctrlKey: true, metaKey: false })).toBe(false);
  });
});

describe('resultHref / resultLabel', () => {
  it('resolves a page result to its own href and label', () => {
    const result: PaletteResult = { kind: 'page', href: '/players', label: 'Игроки' };
    expect(resultHref(result)).toBe('/players');
    expect(resultLabel(result)).toBe('Игроки');
  });

  it('resolves a player result to /players/:id and its canonical name', () => {
    const result: PaletteResult = {
      kind: 'player',
      id: 'p1',
      steam_id64: '7656119800000001',
      canonical_name: 'Alice',
      eos_id: null,
      clan_name: null,
    };
    expect(resultHref(result)).toBe('/players/p1');
    expect(resultLabel(result)).toBe('Alice');
  });

  it('resolves a server result to /servers/:id and its display name', () => {
    const result: PaletteResult = {
      kind: 'server',
      id: 's1',
      display_name: 'Squad EU #1',
      slug: 'eu-1',
    };
    expect(resultHref(result)).toBe('/servers/s1');
    expect(resultLabel(result)).toBe('Squad EU #1');
  });
});
