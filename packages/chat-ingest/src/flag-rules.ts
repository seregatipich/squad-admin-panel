import { chatFlagRules, type DatabaseClient } from '@squad/db';
import {
  type CompiledChatFlagRule,
  compileChatFlagRules,
  detectChatFlag,
  isChatFlagPatternType,
} from '@squad/shared-config';
import { asc, eq } from 'drizzle-orm';

const DEFAULT_TTL_MS = 5_000;

export class ChatFlagDetector {
  private compiled: CompiledChatFlagRule[] = [];
  private loadedAt = 0;

  constructor(
    private readonly db: DatabaseClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  invalidate(): void {
    this.loadedAt = 0;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadedAt !== 0 && Date.now() - this.loadedAt < this.ttlMs) return;
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

  async detect(message: string): Promise<string | null> {
    await this.ensureLoaded();
    return detectChatFlag(message, this.compiled);
  }
}
