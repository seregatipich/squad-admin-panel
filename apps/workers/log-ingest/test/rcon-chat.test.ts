import { setTimeout as sleep } from 'node:timers/promises';
import { PlayerIdCache } from '@squad/chat-ingest';
import {
  automationRules,
  automationRuns,
  chatCommandInvocations,
  createDatabaseClient,
  events,
  playerReports,
  playerStatPeriods,
  players,
  serverSettings,
  servers,
} from '@squad/db';
import {
  RCON_CHAT_GROUP,
  type RconChatEntry,
  rconChatStream,
  rconCommandStream,
} from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAutomationChatRules } from '../src/automation/chat.js';
import { claimChatLine } from '../src/chat/dedupe.js';
import { runRconChatConsumer } from '../src/chat/rcon-chat.js';

/**
 * #2: in-game chat commands (`!stats`, `!rules`, `!report`) and `chat_keyword`
 * automations never fired, because current Squad builds deliver chat only as
 * an RCON broadcast, which worker-rcon receives, while every handler lives in
 * worker-log-ingest and was called only from the log tail. This feeds chat
 * entries the way worker-rcon publishes them (`rcon:chat:<serverId>`) to a
 * real consumer with real Postgres and Redis, and checks the effects the
 * issue names: an `AdminWarn` in `rcon:commands:<id>`, an automation run, a
 * report record.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const redis = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
const blocking = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const SERVER_ID = uuidv7();
const DISABLED_ID = uuidv7();
const PLAYER_ID = uuidv7();
const TARGET_ID = uuidv7();
const EOS = '0257a10186d9414496bf20d22d3860bb';
const STEAM = '76561198000002571';
const TARGET_EOS = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RULES_TEXT = 'Никакого читерства. Уважайте других игроков.';
const KEYWORD = `rconkw-${Date.now()}`;
let ruleId = '';
let stopping = false;
let loop: Promise<void> | undefined;
const log = { warn: vi.fn(), error: vi.fn() };

function entry(message: string, overrides: Partial<RconChatEntry> = {}): RconChatEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    channel: 'ChatAll',
    eos_id: EOS,
    steam_id64: STEAM,
    player_name: 'Alpha Player',
    message,
    ...overrides,
  };
}

async function feed(serverId: string, chat: RconChatEntry): Promise<void> {
  await redis.xadd(rconChatStream(serverId), '*', 'entry', JSON.stringify(chat));
}

async function requests(serverId: string): Promise<{ command: string; args: string[] }[]> {
  const rows = (await redis.xrange(rconCommandStream(serverId), '-', '+')) as [string, string[]][];
  return rows.map(([, fields]) => JSON.parse(fields[fields.indexOf('request') + 1] as string));
}

async function waitFor(probe: () => Promise<boolean>, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

async function clearCooldowns(): Promise<void> {
  const keys = (
    await Promise.all(
      [
        `chat-command:cooldown:${SERVER_ID}:*`,
        `chat:handled:${SERVER_ID}:*`,
        `chat:handled-report:${SERVER_ID}:*`,
        `automation:chat-cooldown:${ruleId}:*`,
      ].map((pattern) => redis.keys(pattern)),
    )
  ).flat();
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await redis.connect();
  await blocking.connect();
  await db.insert(servers).values([
    { id: SERVER_ID, displayName: 'Chat feed server', slug: `chat-feed-${SERVER_ID}` },
    { id: DISABLED_ID, displayName: 'Chat feed off', slug: `chat-feed-off-${DISABLED_ID}` },
  ]);
  await db.insert(serverSettings).values([
    {
      serverId: SERVER_ID,
      installPath: `/tmp/${SERVER_ID}`,
      gamePort: 7787,
      queryPort: 27165,
      beaconPort: 15000,
      rconPort: 21114,
      chatCommandsEnabled: true,
      rulesText: RULES_TEXT,
    },
    {
      serverId: DISABLED_ID,
      installPath: `/tmp/${DISABLED_ID}`,
      gamePort: 7788,
      queryPort: 27166,
      beaconPort: 15001,
      rconPort: 21115,
      chatCommandsEnabled: false,
      rulesText: RULES_TEXT,
    },
  ]);
  await db.insert(players).values([
    {
      id: PLAYER_ID,
      eosId: EOS,
      steamId64: BigInt(STEAM),
      canonicalName: 'Alpha Player',
      canonicalNameNormalized: 'alpha player',
    },
    {
      id: TARGET_ID,
      eosId: TARGET_EOS,
      steamId64: null,
      canonicalName: 'BadGuyRcon',
      canonicalNameNormalized: 'badguyrcon',
    },
  ]);
  await db.insert(playerStatPeriods).values({
    playerId: PLAYER_ID,
    serverId: SERVER_ID,
    periodType: 'alltime',
    periodStart: '1970-01-01',
    kills: 41,
    deaths: 20,
    teamkills: 0,
    revives: 3,
    matchesPlayed: 7,
    onlineSeconds: 3600,
  });
  const [rule] = await db
    .insert(automationRules)
    .values({
      serverId: SERVER_ID,
      name: `rcon-chat-${KEYWORD}`,
      conditionType: 'chat_keyword',
      condition: { keyword: KEYWORD },
      actionType: 'warn',
      action: { message: 'watch your language' },
      enabled: true,
    })
    .returning({ id: automationRules.id });
  ruleId = rule?.id as string;
  invalidateAutomationChatRules();

  // The streams exist before the reader's first look, so its groups start at
  // the end and only what the tests publish is delivered.
  await feed(SERVER_ID, entry('hello'));
  await feed(DISABLED_ID, entry('hello'));
  loop = runRconChatConsumer(
    { db, redis, playerIds: new PlayerIdCache(), log },
    blocking,
    () => stopping,
  );
  await waitFor(async () => {
    const groups = (await redis.xinfo('GROUPS', rconChatStream(SERVER_ID))) as unknown[][];
    return groups.some((group) => group.includes(RCON_CHAT_GROUP));
  });
});

afterEach(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await db.delete(chatCommandInvocations).where(eq(chatCommandInvocations.serverId, SERVER_ID));
  await db.delete(chatCommandInvocations).where(eq(chatCommandInvocations.serverId, DISABLED_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerReports).where(eq(playerReports.serverId, SERVER_ID));
  await db.delete(automationRuns).where(eq(automationRuns.ruleId, ruleId));
  await redis.del(rconCommandStream(SERVER_ID), rconCommandStream(DISABLED_ID));
  await clearCooldowns();
});

afterAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  stopping = true;
  await loop;
  await db.delete(automationRules).where(eq(automationRules.id, ruleId));
  await db.delete(playerStatPeriods).where(eq(playerStatPeriods.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_ID));
  await db.delete(players).where(eq(players.id, TARGET_ID));
  await db.delete(serverSettings).where(eq(serverSettings.serverId, SERVER_ID));
  await db.delete(serverSettings).where(eq(serverSettings.serverId, DISABLED_ID));
  await redis.del(rconChatStream(SERVER_ID), rconChatStream(DISABLED_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, DISABLED_ID));
  await blocking.quit();
  await redis.quit();
  await db.$client.end();
});

describeIfDbAndRedis('chat received over RCON reaches the chat handlers (#2)', () => {
  it('answers !rules with an AdminWarn to the sender and records the invocation', async () => {
    await feed(SERVER_ID, entry('!rules'));
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);

    const [warn] = await requests(SERVER_ID);
    expect(warn).toMatchObject({ command: 'AdminWarn', args: [EOS, RULES_TEXT] });
    const rows = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: 'rules',
      playerId: PLAYER_ID,
      responded: true,
      responseSource: 'rcon_warn',
    });
  });

  it('answers !stats with the sender statistics', async () => {
    await feed(SERVER_ID, entry('!stats'));
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);
    const [warn] = await requests(SERVER_ID);
    expect(warn?.args[0]).toBe(EOS);
    expect(warn?.args[1]).toContain('41');
  });

  it('fires a chat_keyword automation rule', async () => {
    await feed(SERVER_ID, entry(`well ${KEYWORD} indeed`));
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);

    const [warn] = await requests(SERVER_ID);
    expect(warn).toMatchObject({ command: 'AdminWarn', args: [STEAM, 'watch your language'] });
    const runs = await db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, ruleId), eq(automationRuns.dryRun, false)));
    expect(runs.map((run) => run.status)).toEqual(['executed']);
  });

  it('records a !report, acknowledges it, and creates exactly one report', async () => {
    await feed(SERVER_ID, entry('!report BadGuyRcon hacking'));
    await waitFor(async () => {
      const reports = await db
        .select()
        .from(playerReports)
        .where(eq(playerReports.serverId, SERVER_ID));
      return reports.length === 1;
    });
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);

    const [report] = await db
      .select()
      .from(playerReports)
      .where(eq(playerReports.serverId, SERVER_ID));
    expect(report).toMatchObject({ reporterPlayerId: PLAYER_ID, targetPlayerId: TARGET_ID });
    const reportEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'player_report')));
    expect(reportEvents).toHaveLength(1);
    const invocations = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(invocations.map((row) => row.command)).toEqual(['report']);

    // The same line delivered again (a replay, or the log tail) records nothing more.
    await feed(SERVER_ID, entry('!report BadGuyRcon hacking'));
    await sleep(400);
    expect(
      await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID)),
    ).toHaveLength(1);
  });

  it('handles a line once when the log tail delivered it first', async () => {
    const chat = entry('!rules');
    // What the log tail's onChat does before it reacts.
    expect(
      await claimChatLine(redis, SERVER_ID, {
        ts: chat.ts,
        channel: chat.channel,
        eosId: chat.eos_id,
        steamId64: chat.steam_id64,
        playerName: chat.player_name,
        message: chat.message,
      }),
    ).toBe(true);
    await feed(SERVER_ID, chat);
    await sleep(500);
    expect(await requests(SERVER_ID)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatCommandInvocations)
        .where(eq(chatCommandInvocations.serverId, SERVER_ID)),
    ).toHaveLength(0);
  });

  it('lets the log tail see the line as already handled when the feed was first', async () => {
    const chat = entry('!rules');
    await feed(SERVER_ID, chat);
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);
    expect(
      await claimChatLine(redis, SERVER_ID, {
        ts: new Date(Date.parse(chat.ts) + 1500).toISOString(),
        channel: chat.channel,
        eosId: chat.eos_id,
        steamId64: chat.steam_id64,
        playerName: chat.player_name,
        message: chat.message,
      }),
    ).toBe(false);
  });

  it('ignores ordinary chat and respects a server with chat commands disabled', async () => {
    await feed(SERVER_ID, entry('good game everyone'));
    await feed(DISABLED_ID, entry('!rules'));
    await sleep(500);
    expect(await requests(SERVER_ID)).toHaveLength(0);
    expect(await requests(DISABLED_ID)).toHaveLength(0);
  });

  it('drops a malformed entry, keeps reading, and leaves nothing pending', async () => {
    await redis.xadd(rconChatStream(SERVER_ID), '*', 'entry', '{broken');
    await redis.xadd(rconChatStream(SERVER_ID), '*', 'entry', JSON.stringify({ v: 2 }));
    await feed(SERVER_ID, entry('!rules'));
    await waitFor(async () => (await requests(SERVER_ID)).length === 1);
    await sleep(200);
    const pending = (await redis.xpending(rconChatStream(SERVER_ID), RCON_CHAT_GROUP)) as [number];
    expect(pending[0]).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stream: rconChatStream(SERVER_ID) }),
      'malformed rcon chat entry dropped',
    );
  });
});
