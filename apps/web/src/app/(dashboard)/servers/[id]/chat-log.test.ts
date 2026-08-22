import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/live-bus';
import {
  appendChatMessage,
  CHAT_LOG_CAP,
  channelMeta,
  formatChatTime,
  playerHref,
} from './chat-log';

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282ffff';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    server_id: SERVER_A,
    ts: '2026-04-23T11:30:20.485Z',
    channel: 'ChatAll',
    player_id: null,
    player_name: 'Alpha',
    steam_id64: '76561198012345678',
    eos_id: null,
    message: 'hello',
    ...overrides,
  };
}

describe('appendChatMessage', () => {
  it('appends a message for the matching server', () => {
    const next = appendChatMessage([], message({ id: 'a' }), { serverId: SERVER_A });
    expect(next.map((m) => m.id)).toEqual(['a']);
  });

  it('ignores messages for a different server', () => {
    const next = appendChatMessage([], message({ id: 'a', server_id: SERVER_B }), {
      serverId: SERVER_A,
    });
    expect(next).toEqual([]);
  });

  it('deduplicates by message id so replayed tail is not doubled on reconnect', () => {
    const first = appendChatMessage([], message({ id: 'dup' }), { serverId: SERVER_A });
    const second = appendChatMessage(first, message({ id: 'dup' }), { serverId: SERVER_A });
    expect(second).toBe(first);
    expect(second.map((m) => m.id)).toEqual(['dup']);
  });

  it('caps the list at the configured maximum, keeping the newest', () => {
    let list: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      list = appendChatMessage(list, message({ id: `m${i}` }), { serverId: SERVER_A, cap: 3 });
    }
    expect(list.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
  });

  it('defaults the cap to CHAT_LOG_CAP', () => {
    let list: ChatMessage[] = [];
    for (let i = 0; i < CHAT_LOG_CAP + 10; i++) {
      list = appendChatMessage(list, message({ id: `m${i}` }), { serverId: SERVER_A });
    }
    expect(list).toHaveLength(CHAT_LOG_CAP);
    expect(list[list.length - 1].id).toBe(`m${CHAT_LOG_CAP + 9}`);
  });
});

describe('channelMeta', () => {
  it('maps every known channel to a Russian label and badge', () => {
    expect(channelMeta('ChatAll').label).toBe('Все');
    expect(channelMeta('ChatTeam').label).toBe('Команда');
    expect(channelMeta('ChatSquad').label).toBe('Отряд');
    expect(channelMeta('ChatAdmin').label).toBe('Админ');
    expect(channelMeta('ChatAdmin').tone).toBe('crit');
  });
});

describe('playerHref', () => {
  it('links to the player detail page when a uuid is resolved', () => {
    expect(playerHref(message({ player_id: 'uuid-1' }))).toBe('/all-players/uuid-1');
  });

  it('falls back to a steam-scoped players search when only steam id is known', () => {
    expect(playerHref(message({ player_id: null, steam_id64: '76561198012345678' }))).toBe(
      '/all-players?q=76561198012345678',
    );
  });

  it('returns null when the player cannot be linked', () => {
    expect(playerHref(message({ player_id: null, steam_id64: null }))).toBeNull();
  });
});

describe('formatChatTime', () => {
  it('renders a stable placeholder for an invalid timestamp', () => {
    expect(formatChatTime('not-a-date')).toBe('--:--:--');
  });

  it('renders a HH:MM:SS clock for a valid timestamp', () => {
    expect(formatChatTime('2026-04-23T11:30:20.485Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
