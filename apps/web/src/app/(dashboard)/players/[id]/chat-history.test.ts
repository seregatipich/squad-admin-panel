import { describe, expect, it } from 'vitest';
import type { ChatMessage as LiveChatMessage } from '@/lib/live-bus';
import {
  buildChatQuery,
  type ChatFilters,
  type ChatMsg,
  dateInputToIso,
  EMPTY_CHAT_FILTERS,
  formatChatTs,
  liveToChatMsg,
  matchesFilters,
  mergeChatPage,
  prependLiveMessage,
  scopeLabel,
  sourceLabel,
  thirtyDayCountQuery,
} from './chat-history';

const PLAYER = 'b1e2c3d4-0000-0000-0000-000000000001';

function filters(overrides: Partial<ChatFilters> = {}): ChatFilters {
  return { ...EMPTY_CHAT_FILTERS, ...overrides };
}

function msg(id: number, overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id,
    serverId: 'srv-1',
    scope: 'all',
    message: 'hello world',
    source: 'log',
    isFlagged: false,
    teamId: null,
    squadId: null,
    sentAt: '2026-07-01T12:00:00.000Z',
    player: { id: PLAYER, nickname: 'Alpha' },
    ...overrides,
  };
}

function parse(qs: string): URLSearchParams {
  return new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
}

describe('buildChatQuery', () => {
  it('always pins playerId and a default limit with no filters', () => {
    const params = parse(buildChatQuery(PLAYER, filters()));
    expect(params.get('playerId')).toBe(PLAYER);
    expect(params.get('limit')).toBe('50');
    expect(params.has('serverId')).toBe(false);
    expect(params.has('cursor')).toBe(false);
  });

  it('serializes every active filter', () => {
    const params = parse(
      buildChatQuery(
        PLAYER,
        filters({
          serverId: 'srv-2',
          scope: 'admin',
          source: 'panel',
          text: '  flank  ',
          from: '2026-07-01',
          to: '2026-07-02',
        }),
      ),
    );
    expect(params.get('serverId')).toBe('srv-2');
    expect(params.get('scope')).toBe('admin');
    expect(params.get('source')).toBe('panel');
    expect(params.get('text')).toBe('flank');
    expect(params.get('from')).toBe('2026-07-01T00:00:00.000Z');
    expect(params.get('to')).toBe('2026-07-02T23:59:59.999Z');
  });

  it('omits whitespace-only text', () => {
    const params = parse(buildChatQuery(PLAYER, filters({ text: '   ' })));
    expect(params.has('text')).toBe(false);
  });

  it('appends the cursor for keyset paging', () => {
    const params = parse(buildChatQuery(PLAYER, filters(), 'CURSOR==', 25));
    expect(params.get('cursor')).toBe('CURSOR==');
    expect(params.get('limit')).toBe('25');
  });
});

describe('thirtyDayCountQuery', () => {
  it('pins playerId and a from bound 30 days before now', () => {
    const now = Date.parse('2026-07-31T00:00:00.000Z');
    const params = parse(thirtyDayCountQuery(PLAYER, now));
    expect(params.get('playerId')).toBe(PLAYER);
    expect(params.get('from')).toBe('2026-07-01T00:00:00.000Z');
    expect(params.has('to')).toBe(false);
  });
});

describe('dateInputToIso', () => {
  it('returns null for an empty value', () => {
    expect(dateInputToIso('', false)).toBeNull();
  });

  it('maps to start or end of the UTC day', () => {
    expect(dateInputToIso('2026-07-01', false)).toBe('2026-07-01T00:00:00.000Z');
    expect(dateInputToIso('2026-07-01', true)).toBe('2026-07-01T23:59:59.999Z');
  });

  it('returns null for a malformed value', () => {
    expect(dateInputToIso('not-a-date', false)).toBeNull();
  });
});

describe('mergeChatPage', () => {
  it('replaces the list when not appending and dedupes within the page', () => {
    const merged = mergeChatPage([msg(1)], [msg(2), msg(2), msg(3)], false);
    expect(merged.map((m) => m.id)).toEqual([2, 3]);
  });

  it('appends only ids not already present', () => {
    const merged = mergeChatPage([msg(3), msg(2)], [msg(2), msg(1)], true);
    expect(merged.map((m) => m.id)).toEqual([3, 2, 1]);
  });
});

describe('prependLiveMessage', () => {
  it('adds a new message to the front', () => {
    const result = prependLiveMessage([msg(1)], msg(2));
    expect(result.map((m) => m.id)).toEqual([2, 1]);
  });

  it('is a no-op for an already-present id (dedupes the echoed event)', () => {
    const initial = [msg(1)];
    expect(prependLiveMessage(initial, msg(1))).toBe(initial);
  });
});

describe('liveToChatMsg', () => {
  function live(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
    return {
      id: '42',
      server_id: 'srv-1',
      ts: '2026-07-05T10:00:00.000Z',
      channel: 'ChatTeam',
      player_id: PLAYER,
      player_name: 'Alpha',
      steam_id64: null,
      eos_id: null,
      message: 'moving up',
      ...overrides,
    };
  }

  it('maps a live channel event into a table row', () => {
    const row = liveToChatMsg(live());
    expect(row).toEqual({
      id: 42,
      serverId: 'srv-1',
      scope: 'team',
      message: 'moving up',
      source: 'log',
      isFlagged: false,
      teamId: null,
      squadId: null,
      sentAt: '2026-07-05T10:00:00.000Z',
      player: { id: PLAYER, nickname: 'Alpha' },
    });
  });

  it('drops events without a resolved player', () => {
    expect(liveToChatMsg(live({ player_id: null }))).toBeNull();
  });

  it('drops events with a non-numeric id', () => {
    expect(liveToChatMsg(live({ id: 'not-a-number' }))).toBeNull();
  });
});

describe('matchesFilters', () => {
  it('accepts a message when no filters are set', () => {
    expect(matchesFilters(msg(1), filters())).toBe(true);
  });

  it('rejects a mismatched server, scope or source', () => {
    expect(matchesFilters(msg(1), filters({ serverId: 'other' }))).toBe(false);
    expect(matchesFilters(msg(1), filters({ scope: 'admin' }))).toBe(false);
    expect(matchesFilters(msg(1, { source: 'log' }), filters({ source: 'panel' }))).toBe(false);
  });

  it('matches text case-insensitively', () => {
    expect(matchesFilters(msg(1, { message: 'Flank East' }), filters({ text: 'flank' }))).toBe(
      true,
    );
    expect(matchesFilters(msg(1, { message: 'hold' }), filters({ text: 'flank' }))).toBe(false);
  });

  it('honors the from/to day range', () => {
    const june = msg(1, { sentAt: '2026-06-30T12:00:00.000Z' });
    expect(matchesFilters(june, filters({ from: '2026-07-01' }))).toBe(false);
    expect(matchesFilters(msg(1), filters({ from: '2026-07-01', to: '2026-07-01' }))).toBe(true);
    expect(matchesFilters(msg(1), filters({ to: '2026-06-30' }))).toBe(false);
  });
});

describe('labels and formatting', () => {
  it('maps scope and source to Russian labels with a passthrough fallback', () => {
    expect(scopeLabel('admin')).toBe('Админ');
    expect(scopeLabel('unknown')).toBe('unknown');
    expect(sourceLabel('panel')).toBe('Панель');
  });

  it('formats a timestamp and falls back on garbage input', () => {
    expect(formatChatTs('nonsense')).toBe('nonsense');
    expect(formatChatTs('2026-07-01T12:00:00.000Z')).toContain('2026');
  });
});
