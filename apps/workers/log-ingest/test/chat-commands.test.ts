import {
  chatCommandInvocations,
  createDatabaseClient,
  events,
  playerReports,
  playerStatPeriods,
  players,
  serverSettings,
  servers,
} from '@squad/db';
import { rconCommandStream } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleChatCommand } from '../src/chat/commands.js';
import { parseChatLine } from '../src/parser/chat.js';
import { LogIngestor } from '../src/parser/ingest.js';
import { handleReport } from '../src/report/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the AUTO-4 test database');

const db = createDatabaseClient(DATABASE_URL);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
});

const SERVER_ID = uuidv7();
const SERVER_DISABLED_ID = uuidv7();
const PLAYER_ID = uuidv7();
const TARGET_ID = uuidv7();
const EOS = '0002a10186d9414496bf20d22d3860ba';
const STEAM = '76561198012345678';
const TARGET_EOS = 'ffffffffffffffffffffffffffffffff';
const RULES_TEXT = 'Никакого читерства. Уважайте других игроков.';

async function readRconRequests(serverId: string): Promise<{ command: string; args: string[] }[]> {
  const entries = (await redis.xrange(rconCommandStream(serverId), '-', '+')) as [
    string,
    string[],
  ][];
  return entries.map(([, fields]) => {
    const idx = fields.indexOf('request');
    return JSON.parse(fields[idx + 1]);
  });
}

function chatLine(sender: string, text: string): string {
  return `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${sender} : ChatAll : ${text}`;
}

/**
 * A log-line timestamp prefix at "now" so a derived `events.occurred_at` lands
 * in a live partition (the report-store test does the equivalent by setting
 * `report.ts = now()`).
 */
function nowLogPrefix(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}`;
}

const ALPHA_SENDER = `${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Alpha Player`;

beforeAll(async () => {
  await db.insert(servers).values([
    { id: SERVER_ID, displayName: 'AUTO-4 Server', slug: `auto4-${SERVER_ID.slice(0, 8)}` },
    {
      id: SERVER_DISABLED_ID,
      displayName: 'AUTO-4 Disabled',
      slug: `auto4d-${SERVER_DISABLED_ID.slice(0, 8)}`,
    },
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
      serverId: SERVER_DISABLED_ID,
      installPath: `/tmp/${SERVER_DISABLED_ID}`,
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
      canonicalName: 'BadGuy',
      canonicalNameNormalized: 'badguy',
    },
  ]);
  await db.insert(playerStatPeriods).values({
    playerId: PLAYER_ID,
    serverId: SERVER_ID,
    periodType: 'alltime',
    periodStart: '1970-01-01',
    kills: 10,
    deaths: 5,
    teamkills: 1,
    revives: 3,
    matchesPlayed: 7,
    onlineSeconds: 3600,
  });
});

afterEach(async () => {
  await db.delete(chatCommandInvocations).where(eq(chatCommandInvocations.serverId, SERVER_ID));
  await db
    .delete(chatCommandInvocations)
    .where(eq(chatCommandInvocations.serverId, SERVER_DISABLED_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerReports).where(eq(playerReports.serverId, SERVER_ID));
  await redis.del(rconCommandStream(SERVER_ID));
  await redis.del(rconCommandStream(SERVER_DISABLED_ID));
});

afterAll(async () => {
  await db.delete(playerStatPeriods).where(eq(playerStatPeriods.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_ID));
  await db.delete(players).where(eq(players.id, TARGET_ID));
  await db.delete(serverSettings).where(eq(serverSettings.serverId, SERVER_ID));
  await db.delete(serverSettings).where(eq(serverSettings.serverId, SERVER_DISABLED_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_DISABLED_ID));
  await db.$client.end();
  await redis.quit();
});

describe('handleChatCommand', () => {
  it('!stats enqueues an AdminWarn to the requester and records an invocation', async () => {
    const chat = parseChatLine(chatLine(ALPHA_SENDER, '!stats'));
    if (!chat) throw new Error('fixture !stats line failed to parse');

    const outcome = await handleChatCommand(db, redis, { serverId: SERVER_ID, chat });
    expect(outcome?.command).toBe('stats');
    expect(outcome?.responded).toBe(true);

    const requests = await readRconRequests(SERVER_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe('AdminWarn');
    expect(requests[0].args[0]).toBe(EOS);
    expect(requests[0].args[1]).toContain('10');

    const rows = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('stats');
    expect(rows[0].playerId).toBe(PLAYER_ID);
    expect(rows[0].responded).toBe(true);
    expect(rows[0].responseSource).toBe('rcon_warn');
  });

  it('!rules answers with the configured rules_text', async () => {
    const chat = parseChatLine(chatLine(ALPHA_SENDER, '!rules'));
    if (!chat) throw new Error('fixture !rules line failed to parse');

    const outcome = await handleChatCommand(db, redis, { serverId: SERVER_ID, chat });
    expect(outcome?.command).toBe('rules');
    expect(outcome?.responded).toBe(true);

    const requests = await readRconRequests(SERVER_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe('AdminWarn');
    expect(requests[0].args[0]).toBe(EOS);
    expect(requests[0].args[1]).toBe(RULES_TEXT);

    const rows = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('rules');
  });

  it('!report records an AUTO-4 invocation and an RCON ack but does NOT store a player_reports row', async () => {
    const chat = parseChatLine(chatLine(ALPHA_SENDER, '!report BadGuy team killing'));
    if (!chat) throw new Error('fixture !report line failed to parse');

    const outcome = await handleChatCommand(db, redis, { serverId: SERVER_ID, chat });
    expect(outcome?.command).toBe('report');
    expect(outcome?.responded).toBe(true);

    const requests = await readRconRequests(SERVER_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe('AdminWarn');

    const invocations = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(invocations).toHaveLength(1);
    expect(invocations[0].command).toBe('report');
    expect(invocations[0].args).toContain('BadGuy');

    // Delegation guarantee: AUTO-4 must NOT write the report record itself.
    const reports = await db
      .select()
      .from(playerReports)
      .where(eq(playerReports.serverId, SERVER_ID));
    expect(reports).toHaveLength(0);
  });

  it('a !report line through the full ingestor yields exactly one report and one invocation (no duplication)', async () => {
    const raw = `[${nowLogPrefix()}][10]LogSquad: ChatMessage: ${ALPHA_SENDER} : ChatAll : !report BadGuy hacking`;

    const ingestor = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onChat: (chat) => {
        void handleChatCommand(db, redis, { serverId: SERVER_ID, chat });
      },
      onReport: (report) => {
        void handleReport(db, redis, { serverId: SERVER_ID, report });
      },
    });
    ingestor.ingest(raw);
    // Allow the fire-and-forget handlers to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const reports = await db
      .select()
      .from(playerReports)
      .where(eq(playerReports.serverId, SERVER_ID));
    expect(reports).toHaveLength(1);
    expect(reports[0].reporterPlayerId).toBe(PLAYER_ID);
    expect(reports[0].targetPlayerId).toBe(TARGET_ID);

    const reportEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'player_report')));
    expect(reportEvents).toHaveLength(1);

    const invocations = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(invocations).toHaveLength(1);
    expect(invocations[0].command).toBe('report');
  });

  it('does nothing when chat_commands_enabled is false', async () => {
    const chat = parseChatLine(chatLine(ALPHA_SENDER, '!stats'));
    if (!chat) throw new Error('fixture line failed to parse');

    const outcome = await handleChatCommand(db, redis, { serverId: SERVER_DISABLED_ID, chat });
    expect(outcome).toBeNull();

    const requests = await readRconRequests(SERVER_DISABLED_ID);
    expect(requests).toHaveLength(0);

    const rows = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_DISABLED_ID));
    expect(rows).toHaveLength(0);
  });

  it('ignores non-command chat and unknown ! tokens', async () => {
    for (const text of ['hello team', '!foo bar', 'report without bang']) {
      const chat = parseChatLine(chatLine(ALPHA_SENDER, text));
      if (!chat) throw new Error(`fixture line failed to parse: ${text}`);
      const outcome = await handleChatCommand(db, redis, { serverId: SERVER_ID, chat });
      expect(outcome).toBeNull();
    }

    const requests = await readRconRequests(SERVER_ID);
    expect(requests).toHaveLength(0);
    const rows = await db
      .select()
      .from(chatCommandInvocations)
      .where(eq(chatCommandInvocations.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });
});
