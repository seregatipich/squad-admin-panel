import { chatFlagRules, type DatabaseClient } from '@squad/db';
import {
  type CompiledChatFlagRule,
  compileChatFlagRules,
  detectChatFlag,
  isChatFlagPatternType,
} from '@squad/shared-config';
import { asc, eq } from 'drizzle-orm';

const DEFAULT_TTL_MS = 5_000;

/**
 * Matches chat lines against the enabled `chat_flag_rules` (CHATLOG-5).
 *
 * The compiled rule set is cached for `ttlMs` and reloaded lazily on the next
 * `detect()`. Concurrent callers that find the cache stale share one in-flight
 * reload, so a chat burst right after expiry issues a single SELECT. A failed
 * reload rejects every waiter and is not cached: the next call retries.
 */
export class ChatFlagDetector {
  private compiled: CompiledChatFlagRule[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Forces a reload on the next `detect()`. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadedAt !== 0 && Date.now() - this.loadedAt < this.ttlMs) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.reload().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async reload(): Promise<void> {
    const rows = await this.db
      .select({
        id: chatFlagRules.id,
        pattern: chatFlagRules.pattern,
        patternType: chatFlagRules.patternType,
      })
      .from(chatFlagRules)
      .where(eq(chatFlagRules.enabled, true))
      .orderBy(asc(chatFlagRules.createdAt), asc(chatFlagRules.id));
    this.compiled = compileChatFlagRules(
      rows.map((row) => ({
        id: row.id,
        pattern: row.pattern,
        patternType: isChatFlagPatternType(row.patternType) ? row.patternType : 'word',
      })),
    );
    this.loadedAt = Date.now();
  }

  /**
   * @returns The id of the first enabled rule matching `message`, or null.
   * @throws When the rule set cannot be (re)loaded from the database.
   */
  async detect(message: string): Promise<string | null> {
    await this.ensureLoaded();
    return detectChatFlag(message, this.compiled);
  }
}
