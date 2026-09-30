import { bannedNameRules, type DatabaseClient } from '@squad/db';
import { isBannedNameAction, isBannedNameMatchType } from '@squad/shared-config/banned-names';
import { asc, eq } from 'drizzle-orm';
import type {
  BannedNameMatch,
  CompiledBannedNameRuleSet,
  MatchBannedNicknameOptions,
} from './matcher.js';
import { compileBannedNameRules, matchBannedNickname } from './matcher.js';

const DEFAULT_TTL_MS = 30_000;

/**
 * In-memory, TTL-refreshed cache of active `banned_name_rules`, mirroring
 * {@link ChatFlagDetector}'s shape. Reloading is lazy (on the next `match`
 * call after the TTL elapses) rather than on a timer, so an idle worker
 * never polls the database.
 */
export class BannedNameRuleCache {
  private compiled: CompiledBannedNameRuleSet = { exact: [], substring: [], regex: [] };
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  /**
   * @param db - Database the active rules are loaded from.
   * @param ttlMs - How long a loaded rule set is reused before reloading.
   * @param matchOptions - Hooks forwarded to every `matchBannedNickname` call,
   *   e.g. logging a regex rule that exceeded its time budget.
   */
  constructor(
    private readonly db: DatabaseClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly matchOptions: MatchBannedNicknameOptions = {},
  ) {}

  /** Forces the next `match` call to reload from the database. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  /**
   * Concurrent callers share one in-flight load. A failed reload keeps the
   * previously compiled rules and is retried after the TTL; only a failure
   * before any successful load propagates.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loadedAt !== 0 && Date.now() - this.loadedAt < this.ttlMs) return;
    this.loading ??= this.reload().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  private async reload(): Promise<void> {
    try {
      await this.loadRules();
    } catch (err) {
      if (this.loadedAt === 0) throw err;
      this.loadedAt = Date.now();
    }
  }

  private async loadRules(): Promise<void> {
    const rows = await this.db
      .select({
        id: bannedNameRules.id,
        pattern: bannedNameRules.pattern,
        matchType: bannedNameRules.matchType,
        reason: bannedNameRules.reason,
        action: bannedNameRules.action,
      })
      .from(bannedNameRules)
      .where(eq(bannedNameRules.isActive, true))
      .orderBy(asc(bannedNameRules.createdAt), asc(bannedNameRules.id));
    this.compiled = compileBannedNameRules(
      rows.map((row) => ({
        id: row.id,
        pattern: row.pattern,
        matchType: isBannedNameMatchType(row.matchType) ? row.matchType : 'exact',
        reason: row.reason,
        action: isBannedNameAction(row.action) ? row.action : 'kick',
      })),
    );
    this.loadedAt = Date.now();
  }

  async match(nickname: string): Promise<BannedNameMatch | null> {
    await this.ensureLoaded();
    return matchBannedNickname(nickname, this.compiled, this.matchOptions);
  }
}
