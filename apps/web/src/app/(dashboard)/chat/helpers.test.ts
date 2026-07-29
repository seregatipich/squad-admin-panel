import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/live-bus';
import {
  apiItemToRow,
  buildApiQuery,
  buildQueryString,
  CHAT_SCOPES,
  type ChatApiItem,
  type ChatFilters,
  type ChatRow,
  channelToScope,
  combineRows,
  EMPTY_FILTERS,
  formatArchiveTime,
  hasActiveFilters,
  hasDateFilter,
  liveMessageToRow,
  liveRowMatchesFilters,
  parseFilters,
  playerHref,
  prependLiveRow,
  SCOPE_META,
  scopeMeta,
  teamFlagMeta,
  toggleValue,
} from './helpers';

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282ffff';

function filters(overrides: Partial<ChatFilters> = {}): ChatFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

function apiItem(overrides: Partial<ChatApiItem> = {}): ChatApiItem {
  return {
    id: 42,
    serverId: SERVER_A,
    scope: 'team',
    message: 'push the flag',
    source: 'log',
    isFlagged: false,
    teamId: 1,
    squadId: 3,
    sentAt: '2026-07-01T10:00:00.000Z',
    player: { id: 'player-1', nickname: 'Alpha' },
    ...overrides,
  };
}

function liveMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'live-uuid-1',
    server_id: SERVER_A,
    ts: '2026-07-01T12:00:00.000Z',
    channel: 'ChatAll',
    player_id: 'player-9',
    player_name: 'Bravo',
    steam_id64: '76561198000000001',
    eos_id: null,
    message: 'hello world',
    ...overrides,
  };
}

describe('scope palette', () => {
  it('covers every chat scope with icon and badge class', () => {
    for (const scope of CHAT_SCOPES) {
      const meta = SCOPE_META[scope];
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(meta.badgeClass).toContain('bg-');
      expect(meta.labelRu.length).toBeGreaterThan(0);
      expect(meta.labelEn.length).toBeGreaterThan(0);
    }
  });

  it('keeps CHAT-1 palette hues for the four live scopes', () => {
    expect(SCOPE_META.all.badgeClass).toContain('sky');
    expect(SCOPE_META.team.badgeClass).toContain('emerald');
    expect(SCOPE_META.squad.badgeClass).toContain('amber');
    expect(SCOPE_META.admin.badgeClass).toContain('red');
  });

  it('falls back for unknown scopes', () => {
    expect(scopeMeta('unknown').labelRu).toBe('Прочее');
    expect(scopeMeta('team')).toBe(SCOPE_META.team);
  });
});

describe('channelToScope', () => {
  it('maps live channels to archive scopes', () => {
    expect(channelToScope('ChatAll')).toBe('all');
    expect(channelToScope('ChatTeam')).toBe('team');
    expect(channelToScope('ChatSquad')).toBe('squad');
    expect(channelToScope('ChatAdmin')).toBe('admin');
  });
});

describe('parseFilters', () => {
  it('reads repeated server and scope params', () => {
    const params = new URLSearchParams();
    params.set('player', ' Alpha ');
    params.set('text', 'flag');
    params.append('server', SERVER_A);
    params.append('server', SERVER_B);
    params.append('scope', 'team');
    params.append('scope', 'admin');
    params.append('scope', 'bogus');
    params.set('from', '2026-07-01');
    params.set('to', 'not-a-date');
    params.set('flagged', '1');
    const parsed = parseFilters(params);
    expect(parsed.playerQuery).toBe('Alpha');
    expect(parsed.text).toBe('flag');
    expect(parsed.serverIds).toEqual([SERVER_A, SERVER_B]);
    expect(parsed.scopes).toEqual(['team', 'admin']);
    expect(parsed.from).toBe('2026-07-01');
    expect(parsed.to).toBe('');
    expect(parsed.flaggedOnly).toBe(true);
  });

  it('returns empty filters for empty params', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(EMPTY_FILTERS);
  });
});

describe('buildQueryString', () => {
  it('round-trips through parseFilters', () => {
    const original = filters({
      playerQuery: 'Alpha',
      text: 'flag',
      serverIds: [SERVER_A, SERVER_B],
      scopes: ['team', 'admin'],
      from: '2026-07-01',
      flaggedOnly: true,
    });
    const qs = buildQueryString(original);
    expect(parseFilters(new URLSearchParams(qs))).toEqual(original);
  });

  it('omits empty values', () => {
    expect(buildQueryString(EMPTY_FILTERS)).toBe('');
  });
});

describe('buildApiQuery', () => {
  it('maps filters to API parameter names', () => {
    const params = new URLSearchParams(
      buildApiQuery(
        filters({
          playerQuery: 'Alpha',
          text: 'flag',
          serverIds: [SERVER_A, SERVER_B],
          scopes: ['team', 'admin'],
          flaggedOnly: true,
        }),
      ),
    );
    expect(params.get('playerQuery')).toBe('Alpha');
    expect(params.get('text')).toBe('flag');
    expect(params.getAll('serverId')).toEqual([SERVER_A, SERVER_B]);
    expect(params.getAll('scope')).toEqual(['team', 'admin']);
    expect(params.get('flaggedOnly')).toBe('true');
    expect(params.get('limit')).toBe('100');
    expect(params.get('cursor')).toBeNull();
  });

  it('converts a date range to inclusive ISO bounds', () => {
    const params = new URLSearchParams(
      buildApiQuery(filters({ from: '2026-07-01', to: '2026-07-02' })),
    );
    const from = params.get('from');
    const to = params.get('to');
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(new Date(to as string).getTime()).toBeGreaterThan(new Date(from as string).getTime());
  });

  it('appends the cursor when provided', () => {
    const params = new URLSearchParams(buildApiQuery(EMPTY_FILTERS, 'CURSOR123'));
    expect(params.get('cursor')).toBe('CURSOR123');
  });
});

describe('hasDateFilter / hasActiveFilters', () => {
  it('detects date filters', () => {
    expect(hasDateFilter(EMPTY_FILTERS)).toBe(false);
    expect(hasDateFilter(filters({ from: '2026-07-01' }))).toBe(true);
    expect(hasDateFilter(filters({ to: '2026-07-01' }))).toBe(true);
  });

  it('detects any active filter', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ scopes: ['team'] }))).toBe(true);
    expect(hasActiveFilters(filters({ flaggedOnly: true }))).toBe(true);
  });
});

describe('toggleValue', () => {
  it('adds and removes values immutably', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
    const source = ['a'];
    toggleValue(source, 'b');
    expect(source).toEqual(['a']);
  });
});

describe('row mappers', () => {
  it('maps API items to rows', () => {
    const row = apiItemToRow(apiItem());
    expect(row).toMatchObject({
      key: 'db:42',
      id: '42',
      playerId: 'player-1',
      nickname: 'Alpha',
      scope: 'team',
      teamId: 1,
      live: false,
    });
  });

  it('defaults unknown API scope to all', () => {
    expect(apiItemToRow(apiItem({ scope: 'weird' })).scope).toBe('all');
  });

  it('maps live messages to rows with channel-derived scope', () => {
    const row = liveMessageToRow(liveMessage({ channel: 'ChatSquad' }));
    expect(row).toMatchObject({
      key: 'live:live-uuid-1',
      scope: 'squad',
      teamId: null,
      isFlagged: false,
      live: true,
    });
  });
});

describe('liveRowMatchesFilters', () => {
  const row = liveMessageToRow(liveMessage());

  it('matches when no filters are set', () => {
    expect(liveRowMatchesFilters(row, EMPTY_FILTERS)).toBe(true);
  });

  it('rejects everything when flaggedOnly is on', () => {
    expect(liveRowMatchesFilters(row, filters({ flaggedOnly: true }))).toBe(false);
  });

  it('filters by server', () => {
    expect(liveRowMatchesFilters(row, filters({ serverIds: [SERVER_B] }))).toBe(false);
    expect(liveRowMatchesFilters(row, filters({ serverIds: [SERVER_A] }))).toBe(true);
  });

  it('filters by scope', () => {
    expect(liveRowMatchesFilters(row, filters({ scopes: ['team'] }))).toBe(false);
    expect(liveRowMatchesFilters(row, filters({ scopes: ['all'] }))).toBe(true);
  });

  it('filters by text case-insensitively', () => {
    expect(liveRowMatchesFilters(row, filters({ text: 'HELLO' }))).toBe(true);
    expect(liveRowMatchesFilters(row, filters({ text: 'nope' }))).toBe(false);
  });

  it('filters by player nickname substring', () => {
    expect(liveRowMatchesFilters(row, filters({ playerQuery: 'bra' }))).toBe(true);
    expect(liveRowMatchesFilters(row, filters({ playerQuery: 'zzz' }))).toBe(false);
  });
});

describe('prependLiveRow', () => {
  it('prepends new rows and dedups by key', () => {
    const first = liveMessageToRow(liveMessage({ id: 'a' }));
    const second = liveMessageToRow(liveMessage({ id: 'b' }));
    let list: ChatRow[] = [];
    list = prependLiveRow(list, first);
    list = prependLiveRow(list, second);
    list = prependLiveRow(list, first);
    expect(list.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('caps the retained rows', () => {
    let list: ChatRow[] = [];
    for (let index = 0; index < 5; index += 1) {
      list = prependLiveRow(list, liveMessageToRow(liveMessage({ id: `m${index}` })), 3);
    }
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('m4');
  });
});

describe('combineRows', () => {
  it('places live rows first and drops page duplicates by signature', () => {
    const shared = liveMessage({ id: 'live-dup', ts: '2026-07-01T12:00:00.000Z' });
    const liveRow = liveMessageToRow(shared);
    const pageDuplicate = apiItemToRow(
      apiItem({
        id: 100,
        serverId: shared.server_id,
        sentAt: shared.ts,
        player: { id: shared.player_id as string, nickname: shared.player_name },
        message: shared.message,
      }),
    );
    const pageOther = apiItemToRow(apiItem({ id: 200, message: 'different' }));
    const combined = combineRows([liveRow], [pageDuplicate, pageOther]);
    expect(combined.map((row) => row.key)).toEqual(['live:live-dup', 'db:200']);
  });
});

describe('formatting helpers', () => {
  it('formats archive time and handles invalid input', () => {
    expect(formatArchiveTime('not-a-date')).toBe('—');
    expect(formatArchiveTime('2026-07-01T10:00:00.000Z')).not.toBe('—');
  });

  it('builds player hrefs only when a player id exists', () => {
    expect(playerHref(apiItemToRow(apiItem()))).toBe('/all-players/player-1');
    expect(playerHref(liveMessageToRow(liveMessage({ player_id: null })))).toBeNull();
  });

  it('maps team flags', () => {
    expect(teamFlagMeta(1)?.label).toBe('К1');
    expect(teamFlagMeta(2)?.label).toBe('К2');
    expect(teamFlagMeta(null)).toBeNull();
  });
});
