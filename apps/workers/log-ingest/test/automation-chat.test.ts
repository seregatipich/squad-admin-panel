import { auditLog, automationRules, automationRuns, createDatabaseClient } from '@squad/db';
import { rconCommandStream } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { handleAutomationChat, invalidateAutomationChatRules } from '../src/automation/chat.js';
import { parseChatLine } from '../src/parser/chat.js';

const DATABASE_URL = process.env.DATABASE_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const KEYWORD = `trg-${Date.now()}`;
const SERVER_ID = uuidv7();
let ruleId: string;

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

beforeAll(async () => {
  const [row] = await db
    .insert(automationRules)
    .values({
      serverId: null,
      name: `chat-warn-${KEYWORD}`,
      conditionType: 'chat_keyword',
      condition: { keyword: KEYWORD },
      actionType: 'warn',
      action: { message: 'watch your language' },
      enabled: true,
    })
    .returning({ id: automationRules.id });
  ruleId = row?.id as string;
});

afterAll(async () => {
  const cooldownKeys = await redis.keys(`automation:chat-cooldown:${ruleId}:*`);
  if (cooldownKeys.length > 0) await redis.del(...cooldownKeys);
  if (ruleId) await db.delete(automationRules).where(eq(automationRules.id, ruleId));
  await redis.del(rconCommandStream(SERVER_ID)).catch(() => undefined);
  await redis.quit().catch(() => undefined);
});

describeIfDbAndRedis('handleAutomationChat (AUTO-1 chat_keyword)', () => {
  it('fires a matching chat_keyword rule: AdminWarn enqueued + run + audit', async () => {
    const chat = parseChatLine(chatLine('76561198012345678 Tester', `well ${KEYWORD} indeed`));
    expect(chat).not.toBeNull();

    const drafts = await handleAutomationChat(db, redis, {
      serverId: SERVER_ID,
      chat: chat as never,
    });
    expect(drafts.some((d) => d.ruleId === ruleId && d.status === 'executed')).toBe(true);

    const requests = await readRconRequests(SERVER_ID);
    const warn = requests.find((r) => r.command === 'AdminWarn');
    expect(warn).toBeDefined();
    expect(warn?.args[0]).toBe('76561198012345678');
    expect(warn?.args[1]).toBe('watch your language');

    const runs = await db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, ruleId), eq(automationRuns.dryRun, false)));
    expect(runs.some((r) => r.status === 'executed')).toBe(true);

    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, ruleId));
    expect(audits.some((a) => a.actionType === 'automation_rule.fire')).toBe(true);
  });

  it('does not fire when the keyword is absent', async () => {
    await redis.del(rconCommandStream(SERVER_ID));
    const chat = parseChatLine(chatLine('76561198012345678 Tester', 'nothing to trigger here'));
    const drafts = await handleAutomationChat(db, redis, {
      serverId: SERVER_ID,
      chat: chat as never,
    });
    expect(drafts).toHaveLength(0);
    const requests = await readRconRequests(SERVER_ID);
    expect(requests).toHaveLength(0);
  });

  it('fires a rule at most once per player per cooldown window, however often the keyword is repeated (#62)', async () => {
    await redis.del(rconCommandStream(SERVER_ID));
    const chat = parseChatLine(chatLine('76561198012349999 Spammer', `${KEYWORD} ${KEYWORD}`));
    expect(chat).not.toBeNull();

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await handleAutomationChat(db, redis, { serverId: SERVER_ID, chat: chat as never }),
      );
    }

    expect(results[0]?.some((d) => d.ruleId === ruleId)).toBe(true);
    expect(results.slice(1).every((drafts) => drafts.length === 0)).toBe(true);
    const warns = (await readRconRequests(SERVER_ID)).filter(
      (r) => r.command === 'AdminWarn' && r.args[0] === '76561198012349999',
    );
    expect(warns).toHaveLength(1);
  });

  it('reuses the loaded rule set within the TTL and reloads after invalidation (#903)', async () => {
    const lateKeyword = `late-${Date.now()}`;
    const chat = parseChatLine(chatLine('76561198012340001 Cacher', `${lateKeyword} please`));
    const [late] = await db
      .insert(automationRules)
      .values({
        serverId: null,
        name: `chat-late-${lateKeyword}`,
        conditionType: 'chat_keyword',
        condition: { keyword: lateKeyword },
        actionType: 'warn',
        action: { message: 'late' },
        enabled: true,
      })
      .returning({ id: automationRules.id });
    try {
      const cached = await handleAutomationChat(db, redis, {
        serverId: SERVER_ID,
        chat: chat as never,
      });
      expect(cached).toHaveLength(0);

      invalidateAutomationChatRules();
      const reloaded = await handleAutomationChat(db, redis, {
        serverId: SERVER_ID,
        chat: chat as never,
      });
      expect(reloaded.some((d) => d.ruleId === late?.id)).toBe(true);
    } finally {
      const keys = await redis.keys(`automation:chat-cooldown:${late?.id}:*`);
      if (keys.length > 0) await redis.del(...keys);
      if (late) {
        await db.delete(automationRuns).where(eq(automationRuns.ruleId, late.id));
        await db.delete(automationRules).where(eq(automationRules.id, late.id));
      }
      invalidateAutomationChatRules();
    }
  });

  it('records a failed run, not executed, when Redis is unavailable (#904)', async () => {
    const chat = parseChatLine(chatLine('76561198012340002 NoRedis', `${KEYWORD} again`));
    const drafts = await handleAutomationChat(db, null, {
      serverId: SERVER_ID,
      chat: chat as never,
    });
    const draft = drafts.find((d) => d.ruleId === ruleId);
    expect(draft?.status).toBe('failed');
    expect(draft?.actionResult).toMatchObject({ error: expect.stringContaining('redis') });
  });
});
