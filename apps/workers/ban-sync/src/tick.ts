import type { DatabaseClient } from '@squad/db';
import { externalBanSources } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { SyncReport, SyncSourceDeps, SyncSourceInput } from './sync-source.js';
import { syncSource } from './sync-source.js';

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export interface BackoffEntry {
  nextAttemptAt: number;
}

/** In-memory per-source backoff state (mirrors `config-sync`'s `backoffByServer` map). */
export type BackoffMap = Map<string, BackoffEntry>;

/** Exponential backoff by consecutive-failure count, capped at 1 hour: `min(60min, 1min * 2^failures)`. */
export function backoffDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** consecutiveFailures);
}

export interface DueSource extends SyncSourceInput {
  lastSyncAt: Date | null;
  pollIntervalMinutes: number;
}

/** A source is due when it has never synced, or its poll interval has elapsed since the last sync. */
export function isDue(source: DueSource, now: Date): boolean {
  if (!source.lastSyncAt) return true;
  const dueAt = source.lastSyncAt.getTime() + source.pollIntervalMinutes * 60_000;
  return dueAt <= now.getTime();
}

export interface TickResult {
  synced: number;
  failed: number;
  skippedBackoff: number;
}

export interface TickDeps {
  now?: Date;
  listEnabledSources(): Promise<DueSource[]>;
  syncOne(source: DueSource): Promise<SyncReport>;
  backoff: BackoffMap;
  /**
   * Sources being synced right now, shared with the manual-queue consumer:
   * a source already in it is skipped, like one that is not due yet (#853).
   */
  inFlight: Set<string>;
  /** Checked before each source, so a shutdown does not wait for the whole tick. */
  shouldStop?: () => boolean;
}

/**
 * Runs `sync` for `source` unless a sync of the same source is already under
 * way in this process, in which case it returns `null` without running.
 * Two overlapping syncs of one source would read the same existing rows and
 * race each other's inserts, revocations and status writes (#853).
 */
export async function syncExclusively(
  inFlight: Set<string>,
  source: DueSource,
  sync: (source: DueSource) => Promise<SyncReport>,
): Promise<SyncReport | null> {
  if (inFlight.has(source.id)) return null;
  inFlight.add(source.id);
  try {
    return await sync(source);
  } finally {
    inFlight.delete(source.id);
  }
}

/**
 * One poll cycle across every enabled source: syncs each due source
 * sequentially (never in parallel — a slow/misbehaving source must not
 * starve others of their timeout budget), skipping any source still inside
 * its in-memory backoff window from a prior failure or already being synced
 * by an overlapping manual sync. Backoff is cleared on success and
 * (re)computed on failure via `backoffDelayMs`.
 */
export async function runBanSyncTick(deps: TickDeps): Promise<TickResult> {
  const now = deps.now ?? new Date();
  const sources = await deps.listEnabledSources();

  let synced = 0;
  let failed = 0;
  let skippedBackoff = 0;

  for (const source of sources) {
    if (deps.shouldStop?.()) break;
    if (!isDue(source, now)) continue;

    const entry = deps.backoff.get(source.id);
    if (entry && entry.nextAttemptAt > now.getTime()) {
      skippedBackoff++;
      continue;
    }

    const report = await syncExclusively(deps.inFlight, source, deps.syncOne);
    if (!report) continue;
    if (report.ok) {
      deps.backoff.delete(source.id);
      synced++;
    } else {
      const delayMs = backoffDelayMs(source.consecutiveFailures + 1);
      deps.backoff.set(source.id, { nextAttemptAt: now.getTime() + delayMs });
      failed++;
    }
  }

  return { synced, failed, skippedBackoff };
}

/** Wires `runBanSyncTick`'s deps to a real DB (source listing) and the injected sync-source deps. */
export function createTickDeps(
  db: DatabaseClient,
  syncSourceDeps: Omit<SyncSourceDeps, 'now'>,
  backoff: BackoffMap,
  inFlight: Set<string>,
  shouldStop: () => boolean,
): TickDeps {
  return {
    backoff,
    inFlight,
    shouldStop,
    listEnabledSources: async () => {
      const rows = await db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.enabled, true));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        format: row.format,
        authHeaderEncrypted: row.authHeaderEncrypted,
        parserConfig: row.parserConfig,
        consecutiveFailures: row.consecutiveFailures,
        lastSyncAt: row.lastSyncAt,
        pollIntervalMinutes: row.pollIntervalMinutes,
      }));
    },
    syncOne: (source) => syncSource(syncSourceDeps, source),
  };
}
