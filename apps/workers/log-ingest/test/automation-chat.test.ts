import { auditLog, automationRules, automationRuns, createDatabaseClient } from '@squad/db';
import { rconCommandStream } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleAutomationChat } from '../src/automation/chat.js';
import { parseChatLine } from '../src/parser/chat.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the AUTO-1 test database');

const db = createDatabaseClient(DATABASE_URL);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
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
  if (ruleId) await db.delete(automationRules).where(eq(automationRules.id, ruleId));
  await redis.del(rconCommandStream(SERVER_ID)).catch(() => undefined);
  await redis.quit().catch(() => undefined);
});

describe('handleAutomationChat (AUTO-1 chat_keyword)', () => {
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
});
