import { handleChat, recordChatMessage } from '@squad/chat-ingest';
import { type ChatScope, chatMessages, createDatabaseClient, players, servers } from '@squad/db';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatLine } from '../src/parser/chat.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the chatlog1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const IDENTIFIED_ID = uuidv7();
const EOS_ONLY_ID = uuidv7();
const ADMIN_ID = uuidv7();

const IDENTIFIED_EOS = 'dd00ee11ff2233445566778899aabbcc';
const IDENTIFIED_STEAM = '76561199111111111';
const EOS_ONLY_EOS = 'ee11ff22aa33bb44cc55dd6677889900';
const ADMIN_STEAM = '76561199222222222';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function squadLogTs(when: Date): string {
  return (
    `${when.getUTCFullYear()}.${pad(when.getUTCMonth() + 1)}.${pad(when.getUTCDate())}` +
    `-${pad(when.getUTCHours())}.${pad(when.getUTCMinutes())}.${pad(when.getUTCSeconds())}` +
    `:${pad(when.getUTCMilliseconds(), 3)}`
  );
}

function currentMonthPartition(when: Date): string {
  return `chat_messages_${when.getUTCFullYear()}_${pad(when.getUTCMonth() + 1)}`;
}

const NOW = new Date();

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(1) };
}

function rowsForServer() {
  return db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'ChatLog Test Server',
    slug: `chatlog-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: IDENTIFIED_ID,
      eosId: IDENTIFIED_EOS,
      steamId64: BigInt(IDENTIFIED_STEAM),
      canonicalName: 'Alpha Player',
      canonicalNameNormalized: 'alpha player',
    },
    {
      id: EOS_ONLY_ID,
      eosId: EOS_ONLY_EOS,
      steamId64: null,
      canonicalName: 'EosGhost',
      canonicalNameNormalized: 'eosghost',
    },
    {
      id: ADMIN_ID,
      eosId: null,
      steamId64: BigInt(ADMIN_STEAM),
      canonicalName: 'Admin One',
      canonicalNameNormalized: 'admin one',
    },
  ]);
});

afterAll(async () => {
  await db.delete(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, IDENTIFIED_ID));
  await db.delete(players).where(eq(players.id, EOS_ONLY_ID));
  await db.delete(players).where(eq(players.id, ADMIN_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
});

describe('chat message persistence', () => {
  it('persists a parsed chat line with the resolved player_id, mapped scope and log source', async () => {
    const chat = parseChatLine(
      `[${squadLogTs(NOW)}][123]LogSquad: ChatMessage: ${IDENTIFIED_STEAM} [Online IDs: EOS: ${IDENTIFIED_EOS} steam: ${IDENTIFIED_STEAM}] Alpha Player : ChatAll : hello world`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const frame = await handleChat(db, makePublisher(), { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBe(IDENTIFIED_ID);

    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.playerId).toBe(IDENTIFIED_ID);
    expect(row.serverId).toBe(SERVER_ID);
    expect(row.scope).toBe('all');
    expect(row.source).toBe('log');
    expect(row.message).toBe('hello world');
    expect(row.isFlagged).toBe(false);
    expect(row.teamId).toBeNull();
    expect(row.squadId).toBeNull();
    expect(row.sentAt.toISOString()).toBe(chat.ts);
  });

  it('maps each in-game channel to its persisted scope', async () => {
    const channelScopes: Array<[string, ChatScope]> = [
      ['ChatAll', 'all'],
      ['ChatTeam', 'team'],
      ['ChatSquad', 'squad'],
      ['ChatAdmin', 'admin'],
    ];
    for (const [channel, expectedScope] of channelScopes) {
      await db.delete(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
      const chat = parseChatLine(
        `[${squadLogTs(NOW)}][10]LogSquad: ChatMessage: ${IDENTIFIED_STEAM} [Online IDs: EOS: ${IDENTIFIED_EOS} steam: ${IDENTIFIED_STEAM}] Alpha Player : ${channel} : scope check`,
      );
      if (!chat) throw new Error(`fixture chat line failed to parse for ${channel}`);
      await handleChat(db, null, { serverId: SERVER_ID, chat });

      const rows = await rowsForServer();
      expect(rows).toHaveLength(1);
      expect(rows[0].scope).toBe(expectedScope);
    }
  });

  it('links an EOS-only sender by player_id', async () => {
    const chat = parseChatLine(
      `[${squadLogTs(NOW)}][10]LogSquad: ChatMessage: [Online IDs: EOS: ${EOS_ONLY_EOS}] EosGhost : ChatTeam : eos only speaking`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');
    expect(chat.steamId64).toBeNull();

    const frame = await handleChat(db, null, { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBe(EOS_ONLY_ID);

    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    expect(rows[0].playerId).toBe(EOS_ONLY_ID);
    expect(rows[0].scope).toBe('team');
    expect(rows[0].message).toBe('eos only speaking');
  });

  it('does not persist an unresolved sender but still emits the live frame', async () => {
    const chat = parseChatLine(
      `[${squadLogTs(NOW)}][10]LogSquad: ChatMessage: [Online IDs: EOS: cccccccccccccccccccccccccccccccc] Nobody : ChatAll : who am i`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const publisher = makePublisher();
    const frame = await handleChat(db, publisher, { serverId: SERVER_ID, chat });
    expect(frame.data.player_id).toBeNull();
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    const rows = await rowsForServer();
    expect(rows).toHaveLength(0);
  });

  it('records a panel broadcast with scope=broadcast and source=panel', async () => {
    await recordChatMessage(db, {
      playerId: ADMIN_ID,
      serverId: SERVER_ID,
      sentAt: NOW,
      scope: 'broadcast',
      message: 'Server restart in 5 minutes',
      source: 'panel',
    });

    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('broadcast');
    expect(rows[0].source).toBe('panel');
    expect(rows[0].playerId).toBe(ADMIN_ID);
  });

  it('routes an inserted row into the current monthly child partition', async () => {
    await recordChatMessage(db, {
      playerId: ADMIN_ID,
      serverId: SERVER_ID,
      sentAt: NOW,
      scope: 'broadcast',
      message: 'partition routing probe',
      source: 'panel',
    });

    const located = await db.execute(sql`
      SELECT tableoid::regclass::text AS partition
      FROM chat_messages
      WHERE server_id = ${SERVER_ID} AND message = 'partition routing probe'
    `);
    const partition = (located as unknown as Array<{ partition: string }>)[0]?.partition;
    expect(partition).toBe(currentMonthPartition(NOW));
    expect(partition).not.toBe('chat_messages');
  });
});

describe('LogIngestor → chat persistence guard', () => {
  it('keeps the live frame contract intact when the message is not persistable', async () => {
    const chat = parseChatLine(
      `[${squadLogTs(NOW)}][10]LogSquad: ChatMessage: ${IDENTIFIED_STEAM} [Online IDs: EOS: ${IDENTIFIED_EOS} steam: ${IDENTIFIED_STEAM}] Alpha Player : ChatAll : still emits`,
    );
    if (!chat) throw new Error('fixture chat line failed to parse');

    const brokenDb = {
      select: db.select.bind(db),
      insert: () => ({
        values: () => Promise.reject(new Error('no partition of relation chat_messages found')),
      }),
    } as unknown as typeof db;

    const frame = await handleChat(brokenDb, makePublisher(), { serverId: SERVER_ID, chat });
    expect(frame.type).toBe('chat.message');
    expect(frame.data.message).toBe('still emits');

    const rows = await rowsForServer();
    expect(rows).toHaveLength(0);
  });
});
