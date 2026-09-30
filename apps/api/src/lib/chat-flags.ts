import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseClient } from '@squad/db';
import { chatFlagRules, chatMessages } from '@squad/db/schema';
import {
  type CompiledChatFlagRule,
  compileChatFlagRules,
  detectChatFlag,
  isChatFlagPatternType,
} from '@squad/shared-config';
import { and, asc, eq, gte, type SQL, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

const REINDEX_BATCH = 500;

export async function loadCompiledFlagRules(db: DatabaseClient): Promise<CompiledChatFlagRule[]> {
  const rows = await db
    .select({
      id: chatFlagRules.id,
      pattern: chatFlagRules.pattern,
      patternType: chatFlagRules.patternType,
    })
    .from(chatFlagRules)
    .where(eq(chatFlagRules.enabled, true))
    .orderBy(asc(chatFlagRules.createdAt), asc(chatFlagRules.id));
  return compileChatFlagRules(
    rows.map((row) => ({
      id: row.id,
      pattern: row.pattern,
      patternType: isChatFlagPatternType(row.patternType) ? row.patternType : 'word',
    })),
  );
}

export interface ReindexSummary {
  days: number;
  scanned: number;
  flagged: number;
  changed: number;
}

/**
 * Redis key that serialises reindex runs across API replicas and double
 * submits (#345). Held with a TTL so a crashed run cannot wedge the feature.
 */
export const CHAT_FLAG_REINDEX_LOCK_KEY = 'chat-flags:reindex:lock';
const REINDEX_LOCK_TTL_SECONDS = 30 * 60;

/** Deletes the lock only while it still carries this run's token. */
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Runs `task` while holding {@link CHAT_FLAG_REINDEX_LOCK_KEY}.
 *
 * @returns `{ acquired: false }` without running `task` when another run holds
 *   the lock; otherwise `task`'s result. The lock is released on success and
 *   on failure, but never one a later run re-acquired after this one's TTL.
 */
export async function withChatFlagReindexLock<T>(
  redis: Pick<Redis, 'set' | 'eval'>,
  task: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const token = randomUUID();
  const acquired = await redis.set(
    CHAT_FLAG_REINDEX_LOCK_KEY,
    token,
    'EX',
    REINDEX_LOCK_TTL_SECONDS,
    'NX',
  );
  if (acquired !== 'OK') return { acquired: false };
  try {
    return { acquired: true, result: await task() };
  } finally {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, CHAT_FLAG_REINDEX_LOCK_KEY, token);
  }
}

interface ReindexRow {
  id: bigint;
  /** `sent_at::text` — exact to the microsecond, unlike a JS `Date`. */
  sentAt: string;
  message: string;
  isFlagged: boolean;
  matchedRuleId: string | null;
}

/**
 * Re-evaluates the enabled flag rules against every chat message of the last
 * `days` days and rewrites `is_flagged`/`matched_rule_id` where they differ.
 *
 * Walks `chat_messages` with a keyset on `(sent_at, id)`, served by
 * `chat_messages_sent_id_idx` (migration 0128), and applies each page's
 * changes with a single `UPDATE … FROM (VALUES …)` in its own transaction
 * instead of one statement per row (#36). Callers must not run two reindexes
 * at once; the route serialises them with a Redis lock.
 *
 * @returns Counts of scanned, flagged and changed messages.
 */
export async function reindexChatFlags(
  db: DatabaseClient,
  options: { days: number; now?: Date; batchSize?: number },
): Promise<ReindexSummary> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? REINDEX_BATCH;
  const cutoff = new Date(now.getTime() - options.days * 86_400_000);
  const rules = await loadCompiledFlagRules(db);

  let scanned = 0;
  let flagged = 0;
  let changed = 0;
  let cursor: { sentAt: string; id: bigint } | null = null;

  for (;;) {
    // Row comparison on the exact text timestamp: a JS Date cursor would drop
    // the microseconds and could re-read (or loop on) rows within one ms.
    const keyset: SQL | undefined = cursor
      ? and(
          gte(chatMessages.sentAt, cutoff),
          sql`(${chatMessages.sentAt}, ${chatMessages.id}) > (${cursor.sentAt}::timestamptz, ${cursor.id}::bigint)`,
        )
      : gte(chatMessages.sentAt, cutoff);

    const batch: ReindexRow[] = await db
      .select({
        id: chatMessages.id,
        sentAt: sql<string>`${chatMessages.sentAt}::text`,
        message: chatMessages.message,
        isFlagged: chatMessages.isFlagged,
        matchedRuleId: chatMessages.matchedRuleId,
      })
      .from(chatMessages)
      .where(keyset)
      .orderBy(asc(chatMessages.sentAt), asc(chatMessages.id))
      .limit(batchSize);

    if (batch.length === 0) break;

    const updates: SQL[] = [];
    for (const row of batch) {
      scanned += 1;
      const nextRuleId = detectChatFlag(row.message, rules);
      const nextFlagged = nextRuleId !== null;
      if (nextFlagged) flagged += 1;
      if (nextFlagged !== row.isFlagged || nextRuleId !== row.matchedRuleId) {
        updates.push(
          sql`(${row.id}::bigint, ${row.sentAt}::timestamptz, ${nextFlagged}::boolean, ${nextRuleId}::uuid)`,
        );
      }
    }
    if (updates.length > 0) {
      changed += updates.length;
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE chat_messages AS c
             SET is_flagged = v.is_flagged, matched_rule_id = v.matched_rule_id
            FROM (VALUES ${sql.join(updates, sql`, `)})
                 AS v(id, sent_at, is_flagged, matched_rule_id)
           WHERE c.id = v.id AND c.sent_at = v.sent_at
        `);
      });
    }

    const last: ReindexRow | undefined = batch[batch.length - 1];
    if (!last) break;
    cursor = { sentAt: last.sentAt, id: last.id };
    if (batch.length < batchSize) break;
    await setImmediate();
  }

  return { days: options.days, scanned, flagged, changed };
}

/**
 * Clears the flag from every message a rule matched (#346). Called when the
 * rule is deleted, disabled, or re-patterned: those matches no longer reflect
 * the rule set. Newly matching history is only picked up by a reindex.
 */
export async function clearChatFlagsForRule(
  db: Pick<DatabaseClient, 'update'>,
  ruleId: string,
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ isFlagged: false, matchedRuleId: null })
    .where(eq(chatMessages.matchedRuleId, ruleId));
}
