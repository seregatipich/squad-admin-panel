import type { DatabaseClient } from '@squad/db';
import { chatFlagRules, chatMessages } from '@squad/db/schema';
import {
  type CompiledChatFlagRule,
  compileChatFlagRules,
  detectChatFlag,
  isChatFlagPatternType,
} from '@squad/shared-config';
import { and, asc, eq, gt, gte, or, type SQL } from 'drizzle-orm';

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

interface ReindexRow {
  id: bigint;
  sentAt: Date;
  message: string;
  isFlagged: boolean;
  matchedRuleId: string | null;
}

export async function reindexChatFlags(
  db: DatabaseClient,
  options: { days: number; now?: Date },
): Promise<ReindexSummary> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.days * 86_400_000);
  const rules = await loadCompiledFlagRules(db);

  let scanned = 0;
  let flagged = 0;
  let changed = 0;
  let cursor: { sentAt: Date; id: bigint } | null = null;

  for (;;) {
    const keyset: SQL | undefined = cursor
      ? and(
          gte(chatMessages.sentAt, cutoff),
          or(
            gt(chatMessages.sentAt, cursor.sentAt),
            and(eq(chatMessages.sentAt, cursor.sentAt), gt(chatMessages.id, cursor.id)),
          ),
        )
      : gte(chatMessages.sentAt, cutoff);

    const batch: ReindexRow[] = await db
      .select({
        id: chatMessages.id,
        sentAt: chatMessages.sentAt,
        message: chatMessages.message,
        isFlagged: chatMessages.isFlagged,
        matchedRuleId: chatMessages.matchedRuleId,
      })
      .from(chatMessages)
      .where(keyset)
      .orderBy(asc(chatMessages.sentAt), asc(chatMessages.id))
      .limit(REINDEX_BATCH);

    if (batch.length === 0) break;

    for (const row of batch) {
      scanned += 1;
      const nextRuleId = detectChatFlag(row.message, rules);
      const nextFlagged = nextRuleId !== null;
      if (nextFlagged) flagged += 1;
      if (nextFlagged !== row.isFlagged || nextRuleId !== row.matchedRuleId) {
        changed += 1;
        await db
          .update(chatMessages)
          .set({ isFlagged: nextFlagged, matchedRuleId: nextRuleId })
          .where(and(eq(chatMessages.id, row.id), eq(chatMessages.sentAt, row.sentAt)));
      }
    }

    const last: ReindexRow | undefined = batch[batch.length - 1];
    if (!last) break;
    cursor = { sentAt: last.sentAt, id: last.id };
    if (batch.length < REINDEX_BATCH) break;
  }

  return { days: options.days, scanned, flagged, changed };
}
