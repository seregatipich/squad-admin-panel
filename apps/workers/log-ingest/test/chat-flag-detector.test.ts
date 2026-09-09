import { ChatFlagDetector, handleChat } from '@squad/chat-ingest';
import { chatFlagRules, chatMessages, createDatabaseClient, players, servers } from '@squad/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseChatLine } from '../src/parser/chat.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the chatlog5 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const PLAYER_ID = uuidv7();
const EOS = '0002a10186d9414496bf20d22d3860df';
const STEAM = '76561198012345690';
const NEW_RULE_ID = uuidv7();
const PRESEED_RULE_ID = uuidv7();

function chatLine(message: string): ReturnType<typeof parseChatLine> {
  const parsed = parseChatLine(
    `[2026.07.05-11.30.20:485][123]LogSquad: ChatMessage: ${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Flagger : ChatAll : ${message}`,
  );
  if (!parsed) throw new Error('fixture chat line failed to parse');
  return parsed;
}

async function flagStateFor(
  message: string,
): Promise<{ isFlagged: boolean; ruleId: string | null }> {
  const rows = await db
    .select({ isFlagged: chatMessages.isFlagged, ruleId: chatMessages.matchedRuleId })
    .from(chatMessages)
    .where(and(eq(chatMessages.playerId, PLAYER_ID), eq(chatMessages.message, message)))
    .limit(1);
  const row = rows[0];
  return { isFlagged: row?.isFlagged ?? false, ruleId: row?.ruleId ?? null };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Flag Test Server',
    slug: `flag-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values({
    id: PLAYER_ID,
    eosId: EOS,
    steamId64: BigInt(STEAM),
    canonicalName: 'Flagger',
    canonicalNameNormalized: 'flagger',
  });
  await db.insert(chatFlagRules).values({
    id: PRESEED_RULE_ID,
    pattern: 'noobcannon',
    patternType: 'word',
    locale: 'en',
    enabled: true,
  });
});

afterAll(async () => {
  await db.delete(chatMessages).where(eq(chatMessages.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(chatFlagRules).where(eq(chatFlagRules.id, PRESEED_RULE_ID));
  await db.delete(chatFlagRules).where(eq(chatFlagRules.id, NEW_RULE_ID));
  await db.$client.end();
});

describe('ChatFlagDetector + handleChat persistence', () => {
  it('flags a message that matches an active rule and records the matched rule id', async () => {
    const detector = new ChatFlagDetector(db, 0);
    const message = 'that noobcannon spam again';
    await handleChat(db, null, { serverId: SERVER_ID, chat: chatLine(message) }, detector);

    const state = await flagStateFor(message);
    expect(state.isFlagged).toBe(true);
    expect(state.ruleId).toBe(PRESEED_RULE_ID);
  });

  it('leaves a clean message unflagged', async () => {
    const detector = new ChatFlagDetector(db, 0);
    const message = 'good game everyone well played';
    await handleChat(db, null, { serverId: SERVER_ID, chat: chatLine(message) }, detector);

    const state = await flagStateFor(message);
    expect(state.isFlagged).toBe(false);
    expect(state.ruleId).toBeNull();
  });

  it('flags subsequent messages after a new rule is added, without recreating the detector', async () => {
    const detector = new ChatFlagDetector(db, 0);
    const before = 'zzqqword goes here first';
    await handleChat(db, null, { serverId: SERVER_ID, chat: chatLine(before) }, detector);
    expect((await flagStateFor(before)).isFlagged).toBe(false);

    await db.insert(chatFlagRules).values({
      id: NEW_RULE_ID,
      pattern: 'zzqqword',
      patternType: 'word',
      locale: 'all',
      enabled: true,
    });

    const after = 'zzqqword goes here second';
    await handleChat(db, null, { serverId: SERVER_ID, chat: chatLine(after) }, detector);
    const state = await flagStateFor(after);
    expect(state.isFlagged).toBe(true);
    expect(state.ruleId).toBe(NEW_RULE_ID);
  });
});
