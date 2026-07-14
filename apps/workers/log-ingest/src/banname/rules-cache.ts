import { bannedNameRules, type DatabaseClient } from '@squad/db';
import { isBannedNameAction, isBannedNameMatchType } from '@squad/shared-config/banned-names';
import { asc, eq } from 'drizzle-orm';
import type { BannedNameMatch, CompiledBannedNameRuleSet } from './matcher.js';
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

  constructor(
    private readonly db: DatabaseClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Forces the next `match` call to reload from the database. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadedAt !== 0 && Date.now() - this.loadedAt < this.ttlMs) return;
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
    return matchBannedNickname(nickname, this.compiled);
  }
}
