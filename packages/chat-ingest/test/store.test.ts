import { describe, expect, it, vi } from 'vitest';
import {
  buildChatFrame,
  type ChatFlagDetector,
  type ChatInput,
  handleChat,
  LIVE_BUS_CHANNEL,
  PlayerIdCache,
  resolvePlayerId,
} from '../src/index.js';

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
      source: 'log',
    });
  });

  it('gives every message a distinct id', () => {
    const a = buildChatFrame(null, SERVER_ID, chat());
    const b = buildChatFrame(null, SERVER_ID, chat());
    expect(a.data.id).not.toBe(b.data.id);
  });

  it('carries the caller-supplied source instead of always defaulting to log (#470)', () => {
    const frame = buildChatFrame(null, SERVER_ID, chat(), 'rcon');
    expect(frame.data.source).toBe('rcon');
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
    const [channel, payload] = redis.publish.mock.calls[0] ?? [];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    expect(JSON.parse(payload as string)).toEqual(frame);
    expect((db as unknown as { insert: unknown }).insert).not.toHaveBeenCalled();
    // The frame must be labeled with the pipeline that actually carried it,
    // not hardcoded to 'log' — RCON-origin messages were mislabeled and
    // filtered out incorrectly by the panel's «Источник» filter (#470).
    expect(frame.data.source).toBe('rcon');
  });

  it('still returns the frame with no publisher wired', async () => {
    const frame = await handleChat(unknownSenderDb(), null, {
      serverId: SERVER_ID,
      chat: chat({ message: 'offline mode' }),
    });
    expect(frame.data.message).toBe('offline mode');
  });
});

const PLAYER_ID = '01a07b4c-b2d8-742a-9135-236515f86f46';

/**
 * A db stub whose identity lookup resolves to {@link PLAYER_ID} and whose
 * archive insert succeeds, exposing both spies.
 */
function knownSenderDb() {
  const chain: Record<string, unknown> = {
    limit: vi.fn(async () => [{ id: PLAYER_ID }]),
  };
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  const values = vi.fn(async () => undefined);
  const select = vi.fn(() => chain);
  return { db: { select, insert: vi.fn(() => ({ values })) } as never, select, values };
}

describe('handleChat flag detection failures', () => {
  it('archives the line unflagged and reports the detector error instead of swallowing it', async () => {
    const { db, values } = knownSenderDb();
    const detector = {
      detect: vi.fn().mockRejectedValue(new Error('rules query failed')),
    } as unknown as ChatFlagDetector;
    const onFlagError = vi.fn();

    await handleChat(db, null, { serverId: SERVER_ID, chat: chat(), onFlagError }, detector);

    expect(onFlagError).toHaveBeenCalledTimes(1);
    expect((onFlagError.mock.calls[0]?.[0] as Error).message).toBe('rules query failed');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: PLAYER_ID, isFlagged: false, matchedRuleId: null }),
    );
  });
});

describe('resolvePlayerId name fallback (#1057)', () => {
  it('does not match by name when the sender has ids that match nobody', async () => {
    const unknown = unknownSenderDb();
    expect(await resolvePlayerId(unknown, chat({ playerName: '[XYZ] Bob' }))).toBeNull();
    expect(
      (unknown as unknown as { select: ReturnType<typeof vi.fn> }).select,
    ).toHaveBeenCalledTimes(1);
  });

  it('still falls back to the name for a sender without any id', async () => {
    const { db, select } = knownSenderDb();
    const nameOnly = chat({ eosId: null, steamId64: null });
    expect(await resolvePlayerId(db, nameOnly)).toBe(PLAYER_ID);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('handleChat publish failure (#1058)', () => {
  it('archives the line and reports the error when the live-bus publish rejects', async () => {
    const { db, values } = knownSenderDb();
    const publish = vi.fn().mockRejectedValue(new Error('redis down'));
    const onPublishError = vi.fn();

    const frame = await handleChat(
      db,
      { publish },
      { serverId: SERVER_ID, chat: chat(), onPublishError },
    );

    expect(onPublishError).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ playerId: PLAYER_ID }));
    expect(frame.data.message).toBe('hello panel');
  });
});

describe('resolvePlayerId with a PlayerIdCache', () => {
  it('answers a repeat sender from the cache without querying', async () => {
    const { db, select } = knownSenderDb();
    const cache = new PlayerIdCache();

    expect(await resolvePlayerId(db, chat(), cache)).toBe(PLAYER_ID);
    expect(await resolvePlayerId(db, chat(), cache)).toBe(PLAYER_ID);
    expect(await resolvePlayerId(db, chat({ eosId: null }), cache)).toBe(PLAYER_ID);

    expect(select).toHaveBeenCalledTimes(1);
  });

  it('does not cache misses or name-only matches', async () => {
    const cache = new PlayerIdCache();
    const unknown = unknownSenderDb();
    expect(await resolvePlayerId(unknown, chat(), cache)).toBeNull();
    expect(await resolvePlayerId(unknown, chat(), cache)).toBeNull();
    // Each miss runs the ID lookup again; a sender with ids is never name-matched.
    expect(
      (unknown as unknown as { select: ReturnType<typeof vi.fn> }).select,
    ).toHaveBeenCalledTimes(2);

    const { db, select } = knownSenderDb();
    const nameOnly = chat({ eosId: null, steamId64: null });
    await resolvePlayerId(db, nameOnly, cache);
    await resolvePlayerId(db, nameOnly, cache);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('expires entries after the TTL and evicts the oldest entry past the size cap', () => {
    let now = 1_000;
    const cache = new PlayerIdCache({ ttlMs: 100, maxEntries: 2, now: () => now });
    cache.remember(chat({ eosId: 'eos-a', steamId64: null }), 'player-a');
    expect(cache.lookup(chat({ eosId: 'eos-a', steamId64: null }))).toBe('player-a');
    now += 101;
    expect(cache.lookup(chat({ eosId: 'eos-a', steamId64: null }))).toBeUndefined();

    cache.remember(chat({ eosId: 'eos-b', steamId64: null }), 'player-b');
    cache.remember(chat({ eosId: 'eos-c', steamId64: null }), 'player-c');
    cache.remember(chat({ eosId: 'eos-d', steamId64: null }), 'player-d');
    expect(cache.lookup(chat({ eosId: 'eos-b', steamId64: null }))).toBeUndefined();
    expect(cache.lookup(chat({ eosId: 'eos-c', steamId64: null }))).toBe('player-c');
    expect(cache.lookup(chat({ eosId: 'eos-d', steamId64: null }))).toBe('player-d');
  });
});
