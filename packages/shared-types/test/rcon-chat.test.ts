import { describe, expect, it } from 'vitest';
import {
  RCON_CHAT_STREAM_PREFIX,
  rconChatEntrySchema,
  rconChatStream,
  serverIdFromRconChatStream,
} from '../src/rcon-chat.js';

describe('rcon chat feed', () => {
  it('names the stream per server and reads the server id back', () => {
    expect(rconChatStream('abc')).toBe('rcon:chat:abc');
    expect(serverIdFromRconChatStream('rcon:chat:abc')).toBe('abc');
  });

  it('does not take another key for a chat stream', () => {
    expect(serverIdFromRconChatStream('rcon:commands:abc')).toBeNull();
    expect(serverIdFromRconChatStream(RCON_CHAT_STREAM_PREFIX)).toBeNull();
    expect(serverIdFromRconChatStream('rcon:chat:abc:shadow')).toBeNull();
  });

  const entry = {
    v: 1,
    ts: '2026-10-02T12:00:00.000Z',
    channel: 'ChatAll',
    eos_id: 'abcdef0123456789abcdef0123456789',
    steam_id64: null,
    player_name: 'Alpha',
    message: '!rules',
  };

  it('accepts a well-formed entry', () => {
    expect(rconChatEntrySchema.safeParse(entry).success).toBe(true);
  });

  it.each([
    ['another version', { ...entry, v: 2 }],
    ['an unknown channel', { ...entry, channel: 'ChatWhisper' }],
    ['no player name', { ...entry, player_name: '' }],
    ['a bad timestamp', { ...entry, ts: 'yesterday' }],
    ['an extra field', { ...entry, role: 'admin' }],
  ])('rejects %s', (_label, value) => {
    expect(rconChatEntrySchema.safeParse(value).success).toBe(false);
  });
});
