/**
 * AUTO-1 (#72) chat_keyword condition path.
 *
 * Chat is not published to the Redis event stream the automation worker reads,
 * so the `chat_keyword` condition is evaluated here, inline in worker-log-ingest
 * where chat lines are handled (mirroring the AUTO-4 `handleChatCommand` call in
 * `../index.ts`'s `onChat`). Event-driven conditions (player_count,
 * time_of_day, player_flag) are evaluated in `@squad/worker-automation`.
 *
 * A matching rule executes its action through the shared, pure `runMatch`
 * (`@squad/shared-types`) — enqueuing an RCON command / warn / kick, or logging
 * a notify — and records the firing to `automation_runs` + `audit_log`.
 *
 * Each rule fires at most once per player per server within
 * `AUTOMATION_CHAT_COOLDOWN_SECONDS`: a player repeating the keyword must not
 * grow the append-only `audit_log` or flood worker-rcon's capped stream.
 */
import { auditLog, automationRules, automationRuns, type DatabaseClient } from '@squad/db';
import {
  type AutomationRunDraft,
  evaluate,
  type RunMatchDeps,
  runMatch,
} from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import {
  type ChatRedis,
  chatSenderIdentity,
  type RconEnqueue,
  sendRconCommand,
} from '../chat/commands.js';
import type { ParsedChat } from '../parser/chat.js';

/** Minimum gap between two firings of one rule for one player on one server. */
export const AUTOMATION_CHAT_COOLDOWN_SECONDS = 60;

async function loadChatKeywordRules(db: DatabaseClient) {
  const rows = await db
    .select()
    .from(automationRules)
    .where(
      and(eq(automationRules.enabled, true), eq(automationRules.conditionType, 'chat_keyword')),
    );
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    conditionType: row.conditionType,
    condition: row.condition,
    actionType: row.actionType,
    action: row.action,
    enabled: row.enabled,
  }));
}

function createDeps(db: DatabaseClient, redis: RconEnqueue): RunMatchDeps {
  return {
    enqueueRcon: (dispatch) => sendRconCommand(redis, dispatch),
    notifyAdmin: async (_match, dispatch) => ({
      delivered: false,
      detail: { channels: dispatch.channels, via: 'audit_log' },
    }),
    recordRun: async (draft: AutomationRunDraft) => {
      await db.insert(automationRuns).values({
        ruleId: draft.ruleId,
        serverId: draft.serverId,
        matched: draft.matched,
        actionResult: draft.actionResult,
        dryRun: draft.dryRun,
        status: draft.status,
      });
    },
    writeAudit: async (draft) => {
      await db.insert(auditLog).values({
        actorKind: 'system',
        actorPlayerId: null,
        actorTokenId: null,
        actorSystemLabel: 'automation-chat',
        actorIp: null,
        actionType: 'automation_rule.fire',
        targetType: 'automation_rule',
        targetId: draft.ruleId,
        beforeSnapshot: null,
        afterSnapshot: null,
        context: {
          serverId: draft.serverId,
          status: draft.status,
          actionType: draft.actionType,
          intent: draft.intent,
        },
        statusCode: null,
        rowHash: Buffer.from([]),
      });
    },
  };
}

/**
 * Evaluates the enabled `chat_keyword` rules against one chat line and fires
 * every match that is not on cooldown for this player
 * (`automation:chat-cooldown:<rule>:<server>:<player>`, claimed with
 * `SET NX EX`). Returns the recorded drafts (for tests). Never throws — a
 * failure is the caller's to log, matching the other `onChat` handlers.
 */
export async function handleAutomationChat(
  db: DatabaseClient,
  redis: ChatRedis | null,
  { serverId, chat }: { serverId: string; chat: ParsedChat },
): Promise<AutomationRunDraft[]> {
  const rules = await loadChatKeywordRules(db);
  if (rules.length === 0) return [];
  const matches = evaluate(
    {
      serverId,
      now: new Date(chat.ts),
      chatMessage: chat.message,
      player: {
        playerId: null,
        steamId64: chat.steamId64,
        eosId: chat.eosId,
        name: chat.playerName,
      },
    },
    rules,
  );
  if (matches.length === 0) return [];
  const deps = createDeps(db, redis ?? { xadd: async () => null });
  const drafts: AutomationRunDraft[] = [];
  const identity = chatSenderIdentity(chat);
  for (const match of matches) {
    if (redis) {
      const cooldownKey = `automation:chat-cooldown:${match.ruleId}:${serverId}:${identity}`;
      const claimed = await redis.set(
        cooldownKey,
        '1',
        'EX',
        AUTOMATION_CHAT_COOLDOWN_SECONDS,
        'NX',
      );
      if (!claimed) continue;
    }
    drafts.push(await runMatch(deps, match, { dryRun: false }));
  }
  return drafts;
}
