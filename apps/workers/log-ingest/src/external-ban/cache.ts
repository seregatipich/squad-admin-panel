import { type DatabaseClient, externalBanSources, externalBans } from '@squad/db';
import { EXTERNAL_BAN_CACHE_VERSION_KEY } from '@squad/shared-types';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type Redis from 'ioredis';

export type ExternalBanAction = 'none' | 'alert' | 'kick';

export interface ExternalBanMatch {
  externalBanId: string;
  sourceId: string;
  sourceName: string;
  trustLevel: string;
  onMatch: ExternalBanAction;
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
}

interface ExternalBanRow {
  externalBanId: string;
  sourceId: string;
  sourceName: string;
  trustLevel: string;
  onMatch: string;
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
}

function parseAction(value: string): ExternalBanAction {
  return value === 'kick' || value === 'alert' ? value : 'none';
}

/** Loads the active, enabled external bans that can be checked on join. */
export async function loadActiveExternalBans(db: DatabaseClient): Promise<ExternalBanMatch[]> {
  const rows = (await db
    .select({
      externalBanId: externalBans.id,
      sourceId: externalBanSources.id,
      sourceName: externalBanSources.name,
      trustLevel: externalBanSources.trustLevel,
      onMatch: externalBanSources.onMatch,
      steamId64: externalBans.steamId64,
      eosId: externalBans.eosId,
      nickname: externalBans.nickname,
      reason: externalBans.reason,
    })
    .from(externalBans)
    .innerJoin(externalBanSources, eq(externalBanSources.id, externalBans.sourceId))
    .where(
      and(
        eq(externalBanSources.enabled, true),
        isNull(externalBans.revokedAt),
        or(isNull(externalBans.expiresAt), gt(externalBans.expiresAt, new Date())),
      ),
    )) as unknown as ExternalBanRow[];

  return rows.map((row) => ({
    externalBanId: row.externalBanId,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    trustLevel: row.trustLevel,
    onMatch: parseAction(row.onMatch),
    steamId64: row.steamId64,
    eosId: row.eosId,
    nickname: row.nickname,
    reason: row.reason,
  }));
}

/**
 * Hot in-memory index for CBAN-4. CBAN-2 bumps a Redis version after each
 * successful sync, while API source mutations bump it as well, so a connect
 * never waits for a polling TTL before seeing a new ban or action setting.
 */
export class ExternalBanCache {
  private readonly byIdentity = new Map<string, ExternalBanMatch[]>();
  private loaded = false;
  private version: string | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly redis: Pick<Redis, 'get'>,
  ) {}

  async refresh(): Promise<void> {
    const rows = await loadActiveExternalBans(this.db);
    this.byIdentity.clear();
    for (const row of rows) {
      for (const identity of [row.steamId64, row.eosId]) {
        if (!identity) continue;
        const matches = this.byIdentity.get(identity) ?? [];
        matches.push(row);
        this.byIdentity.set(identity, matches);
      }
    }
    this.loaded = true;
  }

  async match(steamId64: string, eosId: string | null): Promise<ExternalBanMatch[]> {
    const version = await this.redis.get(EXTERNAL_BAN_CACHE_VERSION_KEY).catch(() => null);
    if (!this.loaded || version !== this.version) {
      await this.refresh();
      this.version = version;
    }

    const matches = [
      ...(this.byIdentity.get(steamId64) ?? []),
      ...(eosId ? (this.byIdentity.get(eosId) ?? []) : []),
    ];
    return [...new Map(matches.map((row) => [row.externalBanId, row])).values()];
  }
}
