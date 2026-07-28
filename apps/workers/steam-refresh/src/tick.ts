import type { DatabaseClient } from '@squad/db';
import { players } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import {
  fetchSteamBans,
  fetchSteamOwnedGames,
  fetchSteamProfiles,
  STEAM_BATCH_SIZE,
  type SteamBanInfo,
  type SteamOwnedGames,
  type SteamProfile,
} from '@squad/steam-api';
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

export const STEAM_REFRESH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const STEAM_REFRESH_BATCH_SIZE = STEAM_BATCH_SIZE;
const OWNED_GAMES_CONCURRENCY = 4;

export interface SteamRefreshCandidate {
  playerId: string;
  steamId64: bigint;
}

export interface SteamRefreshSnapshot {
  avatarUrl: string | null;
  personaName: string | null;
  profileVisibility: number | null;
  steamAccountCreatedAt: Date | null;
  vacBanned: boolean;
  vacBanCount: number;
  gameBanCount: number;
  daysSinceLastBan: number | null;
  ownsSquad: boolean | null;
  steamPlaytimeMinutes: number | null;
  steamCheckedAt: Date;
}

export interface SteamRefreshTickDeps {
  apiKey: string;
  now?: Date;
  findCandidates(staleBefore: Date, limit: number): Promise<SteamRefreshCandidate[]>;
  fetchProfiles(ids: readonly bigint[]): Promise<Map<string, SteamProfile> | null>;
  fetchBans(ids: readonly bigint[]): Promise<Map<string, SteamBanInfo> | null>;
  fetchOwnedGames(id: bigint): Promise<SteamOwnedGames | null>;
  saveSnapshot(playerId: string, snapshot: SteamRefreshSnapshot): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface SteamRefreshTickResult {
  disabled: boolean;
  selected: number;
  updated: number;
  failed: number;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) results[index] = await fn(item);
      }
    }),
  );
  return results;
}

function buildSnapshot(
  profile: SteamProfile,
  ban: SteamBanInfo,
  ownedGames: SteamOwnedGames,
  now: Date,
): SteamRefreshSnapshot {
  const vacBanCount = ban.vacBanCount;
  const gameBanCount = ban.gameBanCount;
  return {
    avatarUrl: profile.avatarUrl || null,
    personaName: profile.persona || null,
    profileVisibility: profile.visibility,
    steamAccountCreatedAt: profile.createdAt === null ? null : new Date(profile.createdAt * 1000),
    vacBanned: ban.vacBanned,
    vacBanCount,
    gameBanCount,
    daysSinceLastBan: vacBanCount > 0 || gameBanCount > 0 ? ban.daysSinceLastBan : null,
    ownsSquad: ownedGames.ownsSquad,
    steamPlaytimeMinutes: ownedGames.playtimeMinutes,
    steamCheckedAt: now,
  };
}

export async function runSteamRefreshTick(
  deps: SteamRefreshTickDeps,
): Promise<SteamRefreshTickResult> {
  if (!deps.apiKey) {
    const result = { disabled: true, selected: 0, updated: 0, failed: 0 };
    await deps.diag.emit({
      component: 'worker-steam-refresh',
      kind: 'steam_refresh.disabled',
      severity: 'info',
      message: 'Steam refresh is disabled because no API key is configured',
      payload: result,
    });
    return result;
  }

  const now = deps.now ?? new Date();
  const candidates = await deps.findCandidates(
    new Date(now.getTime() - STEAM_REFRESH_STALE_MS),
    STEAM_REFRESH_BATCH_SIZE,
  );
  if (candidates.length === 0) {
    const result = { disabled: false, selected: 0, updated: 0, failed: 0 };
    await deps.diag.emit({
      component: 'worker-steam-refresh',
      kind: 'steam_refresh.run_ok',
      severity: 'info',
      message: 'Steam refresh found no stale players',
      payload: result,
    });
    return result;
  }

  try {
    const ids = candidates.map((candidate) => candidate.steamId64);
    const [profiles, bans, ownedGames] = await Promise.all([
      deps.fetchProfiles(ids),
      deps.fetchBans(ids),
      mapWithConcurrency(candidates, OWNED_GAMES_CONCURRENCY, (candidate) =>
        deps.fetchOwnedGames(candidate.steamId64),
      ),
    ]);
    if (!profiles || !bans) throw new Error('Steam batch request failed');

    let updated = 0;
    let failed = 0;
    for (const [index, candidate] of candidates.entries()) {
      const id = String(candidate.steamId64);
      const profile = profiles.get(id);
      const ban = bans.get(id);
      const owned = ownedGames[index] ?? null;
      if (!profile || !ban || !owned) {
        failed++;
        continue;
      }
      await deps.saveSnapshot(candidate.playerId, buildSnapshot(profile, ban, owned, now));
      updated++;
    }

    const result = {
      disabled: false,
      selected: candidates.length,
      updated,
      failed,
    };
    await deps.diag.emit({
      component: 'worker-steam-refresh',
      kind: failed > 0 ? 'steam_refresh.run_partial' : 'steam_refresh.run_ok',
      severity: failed > 0 ? 'warn' : 'info',
      message: `Steam refresh updated ${updated} of ${candidates.length} players`,
      payload: result,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.diag.emit({
      component: 'worker-steam-refresh',
      kind: 'steam_refresh.run_failed',
      severity: 'error',
      message: `Steam refresh failed: ${message}`,
      payload: { selected: candidates.length, error: message },
    });
    throw error;
  }
}

export function createSteamRefreshDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'set'>,
  apiKey: string,
): Omit<SteamRefreshTickDeps, 'now' | 'diag'> {
  const apiDeps = { apiKey, redis };
  return {
    apiKey,
    findCandidates: async (staleBefore, limit) =>
      db
        .select({ playerId: players.id, steamId64: players.steamId64 })
        .from(players)
        .where(
          and(
            isNotNull(players.steamId64),
            or(isNull(players.steamCheckedAt), lte(players.steamCheckedAt, staleBefore)),
          ),
        )
        .orderBy(sql`${players.steamCheckedAt} ASC NULLS FIRST`)
        .limit(limit)
        .then((rows) =>
          rows.flatMap((row) =>
            row.steamId64 === null ? [] : [{ playerId: row.playerId, steamId64: row.steamId64 }],
          ),
        ),
    fetchProfiles: (ids) => fetchSteamProfiles(ids, apiDeps),
    fetchBans: (ids) => fetchSteamBans(ids, apiDeps),
    fetchOwnedGames: (id) => fetchSteamOwnedGames(id, apiDeps),
    saveSnapshot: async (playerId, snapshot) => {
      await db.update(players).set(snapshot).where(eq(players.id, playerId));
    },
  };
}
