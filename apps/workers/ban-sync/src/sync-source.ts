import type { DatabaseClient } from '@squad/db';
import { externalBanSources, externalBans } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { parseBanList } from './adapters/index.js';
import { raiseBanSyncFailureAlert } from './alerts.js';
import { decrypt, deserialize, loadEncryptionKey } from './crypto.js';
import { buildBansyncEnvelope, persistAndPublish } from './events.js';
import { type FetchBanListResult, fetchBanList } from './fetch-source.js';
import { applyMergePlan, type ExistingBanRow, planMerge } from './merge.js';

/** The failure-streak threshold at which one AUTO-3 alert is raised (see raiseBanSyncFailureAlert). */
export const ALERT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

export interface SyncSourceInput {
  id: string;
  name: string;
  url: string;
  format: string;
  authHeaderEncrypted: Buffer | null;
  parserConfig: Record<string, unknown>;
  consecutiveFailures: number;
}

export interface SyncReport {
  ok: boolean;
  added: number;
  updated: number;
  revoked: number;
  skipped: number;
  durationMs: number;
  bytes: number;
  error?: string;
}

export interface SyncSourceDeps {
  now?: () => Date;
  decryptAuthHeader: (blob: Buffer) => string;
  fetchBanList: (url: string, authHeader: string | null) => Promise<FetchBanListResult>;
  loadExistingBans: (sourceId: string) => Promise<ExistingBanRow[]>;
  applyMergePlan: (
    sourceId: string,
    plan: ReturnType<typeof planMerge>,
  ) => Promise<{ added: number; updated: number; revoked: number }>;
  updateSourceOk: (
    sourceId: string,
    patch: { lastSyncAt: Date; importedCount: number },
  ) => Promise<void>;
  updateSourceError: (
    sourceId: string,
    patch: { lastSyncAt: Date; lastSyncError: string; consecutiveFailures: number },
  ) => Promise<void>;
  persistAndPublish: (envelope: ReturnType<typeof buildBansyncEnvelope>) => Promise<void>;
  raiseFailureAlert: (
    source: { id: string; name: string },
    errorText: string,
    consecutiveFailures: number,
  ) => Promise<number>;
  diag: Pick<Diag, 'emit'>;
}

/**
 * Runs one full sync for a single ban source: decrypt → fetch → parse →
 * merge/apply → persist source status + emit `bansync.completed` on
 * success, or record the error + emit `bansync.failed` (and, on exactly
 * the 3rd consecutive failure, raise the AUTO-3 alert) on any failure at
 * any stage. Never throws — the caller (tick / manual-queue consumer)
 * always gets a `SyncReport` back.
 */
export async function syncSource(
  deps: SyncSourceDeps,
  source: SyncSourceInput,
): Promise<SyncReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  try {
    const authHeader = source.authHeaderEncrypted
      ? deps.decryptAuthHeader(source.authHeaderEncrypted)
      : null;

    const fetched = await deps.fetchBanList(source.url, authHeader);
    const { records, skipped } = parseBanList(source.format, fetched.text, source.parserConfig);
    const existing = await deps.loadExistingBans(source.id);
    const plan = planMerge(existing, records);
    const applied = await deps.applyMergePlan(source.id, plan);

    const totalSkipped = skipped + plan.skippedDuplicateKeys;
    const syncedAt = now();
    await deps.updateSourceOk(source.id, {
      lastSyncAt: syncedAt,
      importedCount: applied.added + applied.updated,
    });

    await deps.persistAndPublish(
      buildBansyncEnvelope('bansync.completed', {
        source_id: source.id,
        added: applied.added,
        updated: applied.updated,
        revoked: applied.revoked,
        skipped: totalSkipped,
        duration_ms: fetched.durationMs,
        bytes: fetched.bytes,
      }),
    );

    await deps.diag.emit({
      component: 'worker-ban-sync',
      kind: 'ban_sync.completed',
      severity: 'info',
      message: `synced source ${source.name}: +${applied.added} ~${applied.updated} -${applied.revoked}`,
      payload: { sourceId: source.id, ...applied, skipped: totalSkipped },
    });

    return {
      ok: true,
      added: applied.added,
      updated: applied.updated,
      revoked: applied.revoked,
      skipped: totalSkipped,
      durationMs: fetched.durationMs,
      bytes: fetched.bytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = source.consecutiveFailures + 1;
    const failedAt = now();

    await deps.updateSourceError(source.id, {
      lastSyncAt: failedAt,
      lastSyncError: message,
      consecutiveFailures,
    });

    await deps.persistAndPublish(
      buildBansyncEnvelope('bansync.failed', {
        source_id: source.id,
        error: message,
        consecutive_failures: consecutiveFailures,
        duration_ms: failedAt.getTime() - startedAt.getTime(),
      }),
    );

    await deps.diag.emit({
      component: 'worker-ban-sync',
      kind: 'ban_sync.failed',
      severity: 'error',
      message: `sync failed for source ${source.name}: ${message}`,
      payload: { sourceId: source.id, error: message, consecutiveFailures },
    });

    if (consecutiveFailures === ALERT_CONSECUTIVE_FAILURE_THRESHOLD) {
      await deps.raiseFailureAlert(
        { id: source.id, name: source.name },
        message,
        consecutiveFailures,
      );
    }

    return {
      ok: false,
      added: 0,
      updated: 0,
      revoked: 0,
      skipped: 0,
      durationMs: failedAt.getTime() - startedAt.getTime(),
      bytes: 0,
      error: message,
    };
  }
}

/** Wires `syncSource`'s injectable deps to real Postgres/Redis/crypto implementations. */
export function createSyncSourceDeps(
  db: DatabaseClient,
  redis: Redis,
  diag: Pick<Diag, 'emit'>,
  encryptionKeyBase64: string,
): Omit<SyncSourceDeps, 'now'> {
  const key = loadEncryptionKey(encryptionKeyBase64);
  return {
    decryptAuthHeader: (blob) => decrypt(key, deserialize(blob)),
    fetchBanList: (url, authHeader) => fetchBanList(url, authHeader),
    loadExistingBans: async (sourceId) => {
      const rows = await db.select().from(externalBans).where(eq(externalBans.sourceId, sourceId));
      return rows as unknown as ExistingBanRow[];
    },
    applyMergePlan: (sourceId, plan) => applyMergePlan(db, sourceId, plan),
    updateSourceOk: async (sourceId, patch) => {
      await db
        .update(externalBanSources)
        .set({
          lastSyncAt: patch.lastSyncAt,
          lastSyncStatus: 'ok',
          lastSyncError: null,
          importedCount: patch.importedCount,
          consecutiveFailures: 0,
        })
        .where(eq(externalBanSources.id, sourceId));
    },
    updateSourceError: async (sourceId, patch) => {
      await db
        .update(externalBanSources)
        .set({
          lastSyncAt: patch.lastSyncAt,
          lastSyncStatus: 'error',
          lastSyncError: patch.lastSyncError,
          consecutiveFailures: patch.consecutiveFailures,
        })
        .where(eq(externalBanSources.id, sourceId));
    },
    persistAndPublish: (envelope) => persistAndPublish(db, redis, envelope),
    raiseFailureAlert: (source, errorText, consecutiveFailures) =>
      raiseBanSyncFailureAlert(db, redis, source, errorText, consecutiveFailures),
    diag,
  };
}
