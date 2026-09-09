import { describe, expect, it, vi } from 'vitest';
import { buildChatFrame, type ChatInput, handleChat, LIVE_BUS_CHANNEL } from '../src/index.js';

const EOS = '0002aaaa000000000000000000000001';
const STEAM = '76561199000000001';
const SERVER_ID = '01a014ad-18e1-71e1-b3f8-1011131ce414';

function chat(overrides: Partial<ChatInput> = {}): ChatInput {
  return {
    ts: '2026-09-09T10:00:00.000Z',
    channel: 'ChatAll',
    eosId: EOS,
    steamId64: STEAM,
    playerName: 'PanelAlpha',
    message: 'hello panel',
    ...overrides,
  };
}

/**
 * A db stub whose identity lookups all resolve empty, so `handleChat` takes the
 * unknown-sender path and persists nothing. Every builder step returns the same
 * chain and `limit()` — where each of `resolvePlayerId`'s queries ends —
 * resolves to no rows.
 */
function unknownSenderDb() {
  const chain: Record<string, unknown> = {
    limit: vi.fn(async () => []),
  };
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  return {
    select: vi.fn(() => chain),
    insert: vi.fn(),
  } as never;
}

describe('buildChatFrame', () => {
  it('carries the sender identity and message onto the live frame', () => {
    const frame = buildChatFrame('01a07b4c-b2d8-742a-9135-236515f86f46', SERVER_ID, chat());
    expect(frame.type).toBe('chat.message');
    expect(frame.data).toMatchObject({
      server_id: SERVER_ID,
      channel: 'ChatAll',
      player_id: '01a07b4c-b2d8-742a-9135-236515f86f46',
      player_name: 'PanelAlpha',
      steam_id64: STEAM,
      eos_id: EOS,
      message: 'hello panel',
      ts: '2026-09-09T10:00:00.000Z',
    });
  });

  it('gives every message a distinct id', () => {
    const a = buildChatFrame(null, SERVER_ID, chat());
    const b = buildChatFrame(null, SERVER_ID, chat());
    expect(a.data.id).not.toBe(b.data.id);
  });
});

describe('handleChat', () => {
  it('publishes the frame on the live bus even when the sender is unknown', async () => {
    const db = unknownSenderDb();
    const redis = { publish: vi.fn().mockResolvedValue(1) };

    const frame = await handleChat(db, redis, {
      serverId: SERVER_ID,
      chat: chat(),
      source: 'rcon',
    });

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = redis.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    expect(JSON.parse(payload as string)).toEqual(frame);
    expect((db as unknown as { insert: unknown }).insert).not.toHaveBeenCalled();
  });

  it('still returns the frame with no publisher wired', async () => {
    const frame = await handleChat(unknownSenderDb(), null, {
      serverId: SERVER_ID,
      chat: chat({ message: 'offline mode' }),
    });
    expect(frame.data.message).toBe('offline mode');
  });
});
