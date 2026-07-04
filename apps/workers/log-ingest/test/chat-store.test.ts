import { createDatabaseClient, playerNameHistory, players, servers } from '@squad/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleChat, LIVE_BUS_CHANNEL } from '../src/chat/store.js';
import { parseChatLine } from '../src/parser/chat.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the chat1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const PLAYER_ID = uuidv7();
const NAMED_ID = uuidv7();
const EOS = '0002a10186d9414496bf20d22d3860ba';
const STEAM = '76561198012345678';

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(1) };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Chat Test Server',
    slug: `chat-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: PLAYER_ID,
      eosId: EOS,
      steamId64: BigInt(STEAM),
      canonicalName: 'Alpha Player',
      canonicalNameNormalized: 'alpha player',
    },
    {
      id: NAMED_ID,
      eosId: null,
      steamId64: null,
      canonicalName: 'PlainName',
      canonicalNameNormalized: 'plainname',
    },
  ]);
});

afterAll(async () => {
  await db.delete(playerNameHistory).where(eq(playerNameHistory.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_ID));
  await db.delete(players).where(eq(players.id, NAMED_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('handleChat', () => {
  it('resolves the sender player uuid by identity and emits a chat.message frame', async () => {
    const chat = parseChatLine(
      `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Alpha Player : ChatAll : hello world`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const publisher = makePublisher();
    const frame = await handleChat(db, publisher, { serverId: SERVER_ID, chat });

    expect(frame.type).toBe('chat.message');
    expect(frame.data.player_id).toBe(PLAYER_ID);
    expect(frame.data.server_id).toBe(SERVER_ID);
    expect(frame.data.channel).toBe('ChatAll');
    expect(frame.data.player_name).toBe('Alpha Player');
    expect(frame.data.steam_id64).toBe(STEAM);
    expect(frame.data.eos_id).toBe(EOS);
    expect(frame.data.message).toBe('hello world');

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publisher.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    const published = JSON.parse(raw as string);
    expect(published.data.id).toBe(frame.data.id);
    expect(published.data.player_id).toBe(PLAYER_ID);
  });

  it('resolves a legacy name-only sender through the players table', async () => {
    const chat = parseChatLine(
      '[2026.04.23-11.32.00:000][10]LogChat: ChatMessage: PlainName : ChatSquad : move up',
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const frame = await handleChat(db, makePublisher(), { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBe(NAMED_ID);
    expect(frame.data.channel).toBe('ChatSquad');
    expect(frame.data.steam_id64).toBeNull();
  });

  it('keeps player_id null for an unknown sender but still emits the message', async () => {
    const chat = parseChatLine(
      `[2026.04.23-11.33.00:000][10]LogSquad: ChatMessage: [Online IDs: EOS: cccccccccccccccccccccccccccccccc] Ghost : ChatTeam : anyone there`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const publisher = makePublisher();
    const frame = await handleChat(db, publisher, { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBeNull();
    expect(frame.data.player_name).toBe('Ghost');
    expect(frame.data.message).toBe('anyone there');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no publisher is provided', async () => {
    const chat = parseChatLine(
      `[2026.04.23-11.34.00:000][10]LogSquad: ChatMessage: ${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Alpha Player : ChatAll : offline mode`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');
    const frame = await handleChat(db, null, { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBe(PLAYER_ID);
  });
});
